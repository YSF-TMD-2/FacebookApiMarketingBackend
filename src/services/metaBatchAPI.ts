import { rateLimitManager } from './rateLimitManager.js';

interface BatchRequest {
  method: string;
  relative_url: string;
  name?: string;
}

interface BatchResponse {
  code: number;
  body: any;
  headers?: any[];
}

interface BatchResult {
  success: boolean;
  data?: any;
  error?: any;
  quotaHeaders?: any;
}

/**
 * Service pour utiliser Meta Batch API
 * Permet de regrouper jusqu'à 50 requêtes en un seul appel
 * Économise significativement le quota API
 */
class MetaBatchAPI {
  private readonly MAX_BATCH_SIZE = 50;
  private readonly API_VERSION = 'v18.0';

  /**
   * Créer un batch request pour récupérer les insights de plusieurs ads
   * Optimisé pour ne récupérer que les champs nécessaires au stop-loss
   */
  createInsightsBatch(adIds: string[], datePreset: string = 'today'): BatchRequest[] {
    const batchRequests: BatchRequest[] = adIds.map((adId, index) => ({
      method: 'GET',
      relative_url: `${adId}/insights?fields=spend,actions&date_preset=${datePreset}`,
      name: `ad_${index}`
    }));

    return batchRequests;
  }

  /**
   * Créer un batch request pour mettre en pause plusieurs ads
   */
  createPauseBatch(adIds: string[]): BatchRequest[] {
    return adIds.map(adId => ({
      method: 'POST',
      relative_url: `${adId}?status=PAUSED`
    }));
  }

  /**
   * Diviser un tableau en chunks de taille maximale
   */
  chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Exécuter un batch request vers Meta API
   */
  async executeBatch(
    accessToken: string,
    batchRequests: BatchRequest[],
    userId: string,
    accountId?: string
  ): Promise<BatchResult[]> {
    // Vérifier le quota avant de faire la requête
    const canMakeRequest = await rateLimitManager.canMakeRequest(userId, accountId);
    if (!canMakeRequest) {
      const waitTime = await rateLimitManager.getWaitTime(userId, accountId);
      if (waitTime > 0) {
        console.log(`⏳ Waiting ${waitTime}ms before batch request due to quota...`);
        await this.sleep(waitTime);
      }
    }

    // Diviser en chunks si nécessaire
    const chunks = this.chunkArray(batchRequests, this.MAX_BATCH_SIZE);
    const results: BatchResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`📦 Processing batch chunk ${i + 1}/${chunks.length} (${chunk.length} requests)`);

      try {
        // Construire l'URL du batch
        const batchUrl = `https://graph.facebook.com/${this.API_VERSION}/?access_token=${accessToken}&batch=${JSON.stringify(chunk)}`;
        
        // Faire la requête batch
        const response = await fetch(batchUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        // Parser les headers de quota
        const quotaHeaders = rateLimitManager.parseQuotaHeaders(response.headers);
        await rateLimitManager.updateQuota(userId, accountId, quotaHeaders);

        const batchData: BatchResponse[] = await response.json();

        // Traiter chaque réponse du batch
        for (let j = 0; j < batchData.length; j++) {
          const batchItem = batchData[j];
          const originalRequest = chunk[j];

          if (batchItem.code === 200) {
            try {
              const body = typeof batchItem.body === 'string' 
                ? JSON.parse(batchItem.body) 
                : batchItem.body;

              results.push({
                success: true,
                data: {
                  adId: this.extractAdIdFromUrl(originalRequest.relative_url),
                  insights: body.data?.[0] || body,
                  quotaHeaders
                }
              });

              // Réinitialiser le backoff en cas de succès
              rateLimitManager.resetBackoff(userId, accountId);
            } catch (parseError) {
              results.push({
                success: false,
                error: { message: 'Failed to parse batch response', parseError },
                quotaHeaders
              });
            }
          } else {
            // Gérer les erreurs (rate limit, etc.)
            const errorBody = typeof batchItem.body === 'string'
              ? JSON.parse(batchItem.body)
              : batchItem.body;

            const error = errorBody.error || { message: 'Unknown error', code: batchItem.code };

            // Si rate limit, appliquer backoff
            if (error.code === 4 || error.code === 17) {
              const backoffDelay = rateLimitManager.getBackoffDelay(userId, accountId);
              rateLimitManager.incrementBackoff(userId, accountId);
              
              console.warn(`⚠️ Rate limit hit, waiting ${backoffDelay}ms before retry...`);
              await this.sleep(backoffDelay);

              // Retry une fois
              try {
                const retryResponse = await fetch(batchUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                });
                const retryData: BatchResponse[] = await retryResponse.json();
                
                if (retryData[j]?.code === 200) {
                  const retryBody = typeof retryData[j].body === 'string'
                    ? JSON.parse(retryData[j].body)
                    : retryData[j].body;

                  results.push({
                    success: true,
                    data: {
                      adId: this.extractAdIdFromUrl(originalRequest.relative_url),
                      insights: retryBody.data?.[0] || retryBody
                    },
                    quotaHeaders: rateLimitManager.parseQuotaHeaders(retryResponse.headers)
                  });
                  continue;
                }
              } catch (retryError) {
                console.error('❌ Retry failed:', retryError);
              }
            }

            results.push({
              success: false,
              error,
              quotaHeaders
            });
          }
        }

        // Délai entre les chunks pour éviter de surcharger
        if (i < chunks.length - 1) {
          await this.sleep(1000); // 1 seconde entre chunks
        }

      } catch (error: any) {
        console.error(`❌ Error processing batch chunk ${i + 1}:`, error);
        results.push({
          success: false,
          error: { message: error.message || 'Batch request failed' }
        });
      }
    }

    return results;
  }

  /**
   * Récupérer les insights optimisés pour stop-loss uniquement
   * Ne récupère que spend et actions (pas toutes les métriques)
   */
  async fetchStopLossInsights(
    accessToken: string,
    adIds: string[],
    userId: string,
    accountId?: string,
    datePreset: string = 'today'
  ): Promise<Map<string, { spend: number; results: number }>> {
    const results = new Map<string, { spend: number; results: number }>();

    // Diviser en batches de 50
    const batches = this.chunkArray(adIds, this.MAX_BATCH_SIZE);

    for (const batch of batches) {
      const batchRequests = this.createInsightsBatch(batch, datePreset);
      const batchResults = await this.executeBatch(accessToken, batchRequests, userId, accountId);

      for (const result of batchResults) {
        if (result.success && result.data) {
          const adId = result.data.adId;
          const insights = result.data.insights;

          // Extraire seulement les données nécessaires pour stop-loss
          const spend = parseFloat(insights.spend || 0);
          let resultsCount = 0;

          // Compter les résultats depuis les actions
          if (insights.actions && Array.isArray(insights.actions)) {
            resultsCount = insights.actions.reduce((total: number, action: any) => {
              // Seulement les actions qui comptent comme résultats
              if (['lead', 'purchase', 'conversion', 'onsite_conversion'].some(type => 
                action.action_type?.includes(type)
              )) {
                return total + parseInt(action.value || 0);
              }
              return total;
            }, 0);
          }

          results.set(adId, { spend, results: resultsCount });
        }
      }
    }

    return results;
  }

  /**
   * Mettre en pause plusieurs ads en batch
   */
  async pauseAdsBatch(
    accessToken: string,
    adIds: string[],
    userId: string,
    accountId?: string
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    const batches = this.chunkArray(adIds, this.MAX_BATCH_SIZE);

    for (const batch of batches) {
      const batchRequests = this.createPauseBatch(batch);
      const batchResults = await this.executeBatch(accessToken, batchRequests, userId, accountId);

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const adId = batch[i];
        results.set(adId, result.success || false);
      }
    }

    return results;
  }

  // ==================== Méthodes privées ====================

  private extractAdIdFromUrl(relativeUrl: string): string {
    // Exemple: "act_123/insights?fields=spend,actions" -> "act_123"
    const match = relativeUrl.match(/^([^/]+)/);
    return match ? match[1] : '';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const metaBatchAPI = new MetaBatchAPI();

