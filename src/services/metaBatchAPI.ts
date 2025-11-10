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
      // Récupérer spend, actions ET conversions pour être sûr d'avoir toutes les données
      // spend: pour calculer Zero Results Spend
      // actions: pour compter les résultats (leads, purchases, conversions)
      // conversions: comme fallback si actions n'est pas disponible
      relative_url: `${adId}/insights?fields=spend,actions,conversions,conversion_values&date_preset=${datePreset}`,
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
        
        console.log(`🔍 [Batch] Batch response received: ${batchData.length} items`);
        console.log(`🔍 [Batch] Batch response structure:`, JSON.stringify(batchData, null, 2));

        // Traiter chaque réponse du batch
        for (let j = 0; j < batchData.length; j++) {
          const batchItem = batchData[j];
          const originalRequest = chunk[j];
          
          console.log(`🔍 [Batch] Processing batch item ${j + 1}/${batchData.length}:`, {
            code: batchItem.code,
            relative_url: originalRequest.relative_url
          });

          if (batchItem.code === 200) {
            try {
              const body = typeof batchItem.body === 'string' 
                ? JSON.parse(batchItem.body) 
                : batchItem.body;
              
              console.log(`🔍 [Batch] Parsed body for item ${j + 1}:`, {
                hasData: !!body.data,
                dataLength: body.data?.length,
                bodyKeys: Object.keys(body)
              });

              const extractedAdId = this.extractAdIdFromUrl(originalRequest.relative_url);
              const insights = body.data?.[0] || body;
              
              console.log(`🔍 [Batch] Extracted adId: ${extractedAdId}`);
              console.log(`🔍 [Batch] Insights structure:`, {
                hasSpend: !!insights.spend,
                hasActions: !!insights.actions,
                hasConversions: !!insights.conversions,
                insightsKeys: Object.keys(insights)
              });

              results.push({
                success: true,
                data: {
                  adId: extractedAdId,
                  insights: insights,
                  quotaHeaders
                }
              });
              
              console.log(`✅ [Batch] Successfully processed batch item ${j + 1} for ad ${extractedAdId}`);

              // Réinitialiser le backoff en cas de succès
              rateLimitManager.resetBackoff(userId, accountId);
            } catch (parseError) {
              console.error(`❌ [Batch] Failed to parse batch response for item ${j + 1}:`, parseError);
              results.push({
                success: false,
                error: { message: 'Failed to parse batch response', parseError },
                quotaHeaders
              });
            }
          } else {
            // Gérer les erreurs (rate limit, etc.)
            console.error(`❌ [Batch] Batch item ${j + 1} failed with code ${batchItem.code}`);
            const errorBody = typeof batchItem.body === 'string'
              ? JSON.parse(batchItem.body)
              : batchItem.body;

            const error = errorBody.error || { message: 'Unknown error', code: batchItem.code };
            console.error(`❌ [Batch] Error details:`, error);

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
        console.log(`🔍 [Batch] Processing batch result:`, {
          success: result.success,
          hasData: !!result.data,
          dataKeys: result.data ? Object.keys(result.data) : []
        });
        
        if (result.success && result.data) {
          const adId = result.data.adId;
          const insights = result.data.insights;
          
          console.log(`🔍 [Batch] Extracted adId: ${adId}, has insights: ${!!insights}`);
          
          if (!adId) {
            console.error(`❌ [Batch] No adId found in result.data:`, result.data);
            continue;
          }
          
          if (!insights) {
            console.error(`❌ [Batch] No insights found for ad ${adId}:`, result.data);
            continue;
          }

          // Extraire seulement les données nécessaires pour stop-loss
          const spend = parseFloat(insights.spend || 0);
          let resultsCount = 0;

          // Compter les résultats depuis les actions
          // Priorité: utiliser conversions/conversion_values de Facebook (plus fiable, évite les doublons)
          // Sinon, compter uniquement les types exacts 'lead', 'purchase', 'conversion' (pas les variations)
          if (insights.conversions || insights.conversion_values) {
            resultsCount = parseFloat(insights.conversions || insights.conversion_values || 0);
            console.log(`🔍 [Batch] Using conversions field for ad ${adId}: ${resultsCount}`);
          } else if (insights.actions && Array.isArray(insights.actions)) {
            console.log(`🔍 [Batch] Actions for ad ${adId}:`, JSON.stringify(insights.actions, null, 2));
            
            // Compter uniquement les types exacts pour éviter les doublons
            resultsCount = insights.actions.reduce((total: number, action: any) => {
              const actionType = action.action_type || '';
              const actionValue = parseInt(action.value || 0);
              
              // Utiliser uniquement les types exacts, pas les variations (pour éviter les doublons)
              const isResult = actionType === 'lead' || 
                              actionType === 'purchase' || 
                              actionType === 'conversion';
              
              if (isResult && actionValue > 0) {
                console.log(`✅ [Batch] Found result action for ad ${adId}: type=${actionType}, value=${actionValue}`);
                return total + actionValue;
              }
              return total;
            }, 0);
            
            console.log(`🔍 [Batch] Total results from actions (exact types only) for ad ${adId}: ${resultsCount}`);
          } else {
            console.log(`⚠️ [Batch] No conversions or actions data for ad ${adId}`);
          }

          console.log(`📊 [Batch] Final metrics for ad ${adId}: spend=$${spend.toFixed(2)}, results=${resultsCount}`);
          results.set(adId, { spend, results: resultsCount });
        } else {
          console.error(`❌ [Batch] Batch result failed or missing data:`, {
            success: result.success,
            error: result.error,
            hasData: !!result.data
          });
        }
      }
    }

    console.log(`📊 [Batch] Total metrics retrieved: ${results.size} ads`);
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
    console.log(`🛑 [Batch] Attempting to pause ${adIds.length} ads`);
    const results = new Map<string, boolean>();
    const batches = this.chunkArray(adIds, this.MAX_BATCH_SIZE);

    for (const batch of batches) {
      console.log(`🛑 [Batch] Processing pause batch of ${batch.length} ads`);
      console.log(`🛑 [Batch] Ad IDs to pause:`, batch);
      const batchRequests = this.createPauseBatch(batch);
      console.log(`🛑 [Batch] Batch requests created:`, batchRequests.map(req => req.relative_url));
      
      const batchResults = await this.executeBatch(accessToken, batchRequests, userId, accountId);
      console.log(`🛑 [Batch] Received ${batchResults.length} batch results`);

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const adId = batch[i];
        
        console.log(`🔍 [Batch] Processing pause result ${i + 1}/${batchResults.length} for ad ${adId}:`, {
          success: result.success,
          hasError: !!result.error,
          error: result.error
        });
        
        const success = result.success || false;
        results.set(adId, success);
        
        if (success) {
          console.log(`✅ [Batch] Ad ${adId} paused successfully via batch API`);
        } else {
          console.error(`❌ [Batch] Failed to pause ad ${adId}:`, result.error || 'Unknown error');
          if (result.error) {
            console.error(`❌ [Batch] Error details for ad ${adId}:`, JSON.stringify(result.error, null, 2));
          }
        }
      }
    }
    
    const successCount = Array.from(results.entries()).filter(([_, success]) => success).length;
    const failedCount = results.size - successCount;
    
    console.log(`📊 [Batch] Pause results summary: ${successCount}/${results.size} ads paused successfully`);
    
    if (failedCount > 0) {
      const failedAds = Array.from(results.entries())
        .filter(([_, success]) => !success)
        .map(([adId]) => adId);
      console.warn(`⚠️ [Batch] ${failedCount} ads failed to pause:`, failedAds);
    }
    
    if (successCount === 0 && results.size > 0) {
      console.error(`❌ [Batch] CRITICAL: All ${results.size} ads failed to pause!`);
      console.error(`❌ [Batch] This indicates a serious issue with the batch API or Facebook API access.`);
      console.error(`❌ [Batch] Possible causes:`);
      console.error(`   - Invalid access token`);
      console.error(`   - Insufficient permissions`);
      console.error(`   - Rate limit exceeded`);
      console.error(`   - Network/API connectivity issues`);
      console.error(`❌ [Batch] Failed ad IDs:`, Array.from(results.keys()));
    }

    return results;
  }

  // ==================== Méthodes privées ====================

  private extractAdIdFromUrl(relativeUrl: string): string {
    
    const match = relativeUrl.match(/^([^/?]+)/);
    const extracted = match ? match[1] : '';
    console.log(`🔍 [Batch] Extracting adId from URL "${relativeUrl}" -> "${extracted}"`);
    return extracted;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const metaBatchAPI = new MetaBatchAPI();

