import { supabase } from '../supabaseClient.js';
import { getSupabaseAdminClient } from '../middleware/roleMiddleware.js';
import { metaBatchAPI } from './metaBatchAPI.js';
import { rateLimitManager } from './rateLimitManager.js';
import StopLossSettingsService from './stopLossSettingsService.js';

interface BatchConfig {
  enabled: boolean;
  batch_interval_ms: number;
  max_parallel_requests: number;
  batch_size: number;
  max_retries: number;
  retry_delay_base_ms: number;
  backoff_multiplier: number;
  quota_threshold_percent: number;
  throttle_enabled: boolean;
}

interface AdWithStopLoss {
  ad_id: string;
  user_id: string;
  account_id: string;
  cost_per_result_threshold?: number;
  zero_results_spend_threshold?: number;
  cpr_enabled?: boolean;
  zero_results_enabled?: boolean;
  enabled: boolean;
}

interface AdMetrics {
  spend: number;
  results: number;
}

interface ProcessedAd {
  adId: string;
  userId: string;
  accountId: string;
  metrics: AdMetrics;
  shouldStop: boolean;
  reason?: string;
  adName?: string;
  threshold?: number;
  actualValue?: number;
  costPerResultThreshold?: number;
  zeroResultsSpendThreshold?: number;
}

/**
 * Service Stop-Loss Optimisé
 * - Utilise Meta Batch API (économie de quota)
 * - Ne récupère que les données nécessaires (spend, actions)
 * - Gère intelligemment les rate limits
 * - Traite par batch pour performance multi-ads
 */
class OptimizedStopLossService {
  private batchInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private config: BatchConfig | null = null;

  /**
   * Initialiser le service avec la config admin
   */
  async initialize(): Promise<void> {
    await this.loadConfig();
    if (this.config?.enabled) {
      await this.start();
    }
    console.log('✅ Optimized Stop-Loss Service initialized');
  }

  /**
   * Charger la configuration depuis system_settings
   */
  private async loadConfig(): Promise<void> {
    try {
      const { data, error } = await (supabase
        .from('system_settings') as any)
        .select('value')
        .eq('key', 'stop_loss_batch')
        .single();

      if (error || !data) {
        // Utiliser config par défaut
        this.config = {
          enabled: true,
          batch_interval_ms: 60000, // 1 minute
          max_parallel_requests: 10,
          batch_size: 50,
          max_retries: 3,
          retry_delay_base_ms: 1000,
          backoff_multiplier: 2,
          quota_threshold_percent: 80,
          throttle_enabled: true
        };
        console.log('⚠️ Using default batch config');
        return;
      }

      this.config = ((data as any).value as any) as BatchConfig;
      console.log('✅ Batch config loaded:', this.config);
    } catch (error) {
      console.error('❌ Error loading config:', error);
      throw error;
    }
  }

  /**
   * Démarrer le service de batch
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Stop-loss service already running');
      return;
    }

    await this.loadConfig();
    if (!this.config?.enabled) {
      console.log('⚠️ Stop-loss batch is disabled in config');
      return;
    }

    // Vérifier s'il y a des ads à surveiller avant de démarrer
    const adsWithStopLoss = await this.getAdsWithStopLoss();
    if (adsWithStopLoss.length === 0) {
      console.log('📭 No ads with stop-loss enabled - service will not start');
      console.log('💡 Service will automatically start when a stop-loss is enabled');
      return;
    }

    this.isRunning = true;
    console.log(`🚀 Starting optimized stop-loss service (interval: ${this.config.batch_interval_ms}ms)`);
    console.log(`📊 Monitoring ${adsWithStopLoss.length} ads with stop-loss enabled`);

    // Exécuter immédiatement
    await this.processBatch();

    // Puis à intervalle régulier
    this.batchInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.processBatch();
      }
    }, this.config.batch_interval_ms);
  }
  
  /**
   * Redémarrer le service si nécessaire (quand une nouvelle ad avec stop-loss est activée)
   */
  async restartIfNeeded(): Promise<void> {
    if (!this.config) {
      await this.loadConfig();
    }
    
    if (!this.config?.enabled) {
      return;
    }

    // Si le service n'est pas en cours d'exécution, vérifier s'il y a des ads à surveiller
    if (!this.isRunning) {
      const adsWithStopLoss = await this.getAdsWithStopLoss();
      if (adsWithStopLoss.length > 0) {
        console.log(`🔄 Restarting stop-loss service - ${adsWithStopLoss.length} ads to monitor`);
        await this.start();
      }
    }
  }

  /**
   * Arrêter le service
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    console.log('🛑 Optimized stop-loss service stopped');
  }

  /**
   * Traiter un batch de publicités
   */
  private async processBatch(): Promise<void> {
    if (!this.config) {
      await this.loadConfig();
    }

    if (!this.config?.enabled) {
      return;
    }

    try {
      console.log('🔄 Starting stop-loss batch processing...');

      // 1. Récupérer toutes les ads avec stop-loss activé
      const adsWithStopLoss = await this.getAdsWithStopLoss();
      
      if (adsWithStopLoss.length === 0) {
        console.log('📭 No ads with stop-loss enabled - stopping batch service');
        // Arrêter le service batch s'il n'y a plus d'ads à surveiller
        await this.stop();
        return;
      }

      console.log(`📊 Processing ${adsWithStopLoss.length} ads with stop-loss enabled`);

      // 2. Grouper par utilisateur et compte publicitaire
      const groupedAds = this.groupAdsByUserAndAccount(adsWithStopLoss);

      // 3. Filtrer les groupes selon la config batch par utilisateur (enabled/disabled)
      const filteredGroups = await this.filterGroupsByUserBatchConfig(groupedAds);

      // 4. Traiter chaque groupe en parallèle (limité par max_parallel_requests)
      const groups = Array.from(filteredGroups.entries());
      const parallelLimit = this.config.max_parallel_requests || 10;
      
      for (let i = 0; i < groups.length; i += parallelLimit) {
        const batch = groups.slice(i, i + parallelLimit);
        
        await Promise.all(
          batch.map(([key, ads]) => this.processAdGroup(key, ads))
        );

        // Délai entre les groupes pour éviter de surcharger
        if (i + parallelLimit < groups.length) {
          await this.sleep(1000);
        }
      }

      console.log('✅ Stop-loss batch processing completed');

    } catch (error) {
      console.error('❌ Error in batch processing:', error);
    }
  }

  /**
   * Récupérer toutes les ads avec stop-loss activé
   */
  private async getAdsWithStopLoss(): Promise<AdWithStopLoss[]> {
    try {
      // Utiliser le client admin pour contourner les RLS policies
      const supabaseAdmin = getSupabaseAdminClient();
      const { data, error } = await (supabaseAdmin
        .from('stop_loss_settings') as any)
        .select('*')
        .eq('enabled', true);

      if (error) {
        console.error('❌ [Batch] Error fetching ads with stop-loss:', error);
        console.error('❌ [Batch] Error details:', JSON.stringify(error, null, 2));
        throw error;
      }

      const ads = (data || []).map((item: any) => ({
        ad_id: item.ad_id,
        user_id: item.user_id,
        account_id: item.account_id,
        cost_per_result_threshold: item.cost_per_result_threshold,
        zero_results_spend_threshold: item.zero_results_spend_threshold,
        cpr_enabled: item.cpr_enabled !== null ? item.cpr_enabled : true, // Par défaut true si null pour rétrocompatibilité
        zero_results_enabled: item.zero_results_enabled !== null ? item.zero_results_enabled : true, // Par défaut true si null pour rétrocompatibilité
        enabled: item.enabled
      }));

      console.log(`📊 [Batch] Found ${ads.length} ads with stop-loss enabled`);
      ads.forEach(ad => {
        console.log(`  - Ad ${ad.ad_id}: zero_results_spend=${ad.zero_results_spend_threshold}, cost_per_result=${ad.cost_per_result_threshold}`);
      });

      return ads;
    } catch (error) {
      console.error('❌ [Batch] Error fetching ads with stop-loss:', error);
      return [];
    }
  }

  /**
   * Grouper les ads par utilisateur et compte publicitaire
   * Pour optimiser les appels batch API
   */
  private groupAdsByUserAndAccount(
    ads: AdWithStopLoss[]
  ): Map<string, AdWithStopLoss[]> {
    const grouped = new Map<string, AdWithStopLoss[]>();

    for (const ad of ads) {
      const key = `${ad.user_id}:${ad.account_id}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(ad);
    }

    return grouped;
  }

  /**
   * Filtrer les groupes selon la configuration batch par utilisateur
   * Si un utilisateur a batch.enabled = false, ses ads ne sont pas traitées
   */
  private async filterGroupsByUserBatchConfig(
    groupedAds: Map<string, AdWithStopLoss[]>
  ): Promise<Map<string, AdWithStopLoss[]>> {
    try {
      // Récupérer toutes les configs batch des utilisateurs concernés
      const userIds = Array.from(new Set(
        Array.from(groupedAds.values())
          .flat()
          .map(ad => ad.user_id)
      ));

      if (userIds.length === 0) {
        return groupedAds;
      }

      const { data: batchConfigs, error } = await (supabase
        .from('user_batch_config') as any)
        .select('user_id, enabled')
        .in('user_id', userIds);

      if (error) {
        console.warn('⚠️ Error fetching user batch configs, proceeding with all users:', error);
        return groupedAds;
      }

      // Créer un map user_id -> enabled
      const userEnabledMap = new Map<string, boolean>();
      batchConfigs?.forEach((config: any) => {
        userEnabledMap.set(config.user_id, config.enabled !== false); // true par défaut si non défini
      });

      // Filtrer les groupes: garder seulement ceux dont l'utilisateur a enabled=true
      const filtered = new Map<string, AdWithStopLoss[]>();
      
      for (const [key, ads] of groupedAds.entries()) {
        const userId = ads[0]?.user_id;
        if (!userId) continue;

        // Si pas de config ou enabled=true, inclure le groupe
        const isEnabled = userEnabledMap.get(userId) ?? true; // true par défaut
        
        if (isEnabled) {
          filtered.set(key, ads);
        } else {
          console.log(`⏸️ Skipping user ${userId.substring(0, 8)}... (batch disabled)`);
        }
      }

      return filtered;
    } catch (error) {
      console.error('❌ Error filtering groups by user batch config:', error);
      // En cas d'erreur, retourner tous les groupes pour ne pas bloquer le traitement
      return groupedAds;
    }
  }

  /**
   * Traiter un groupe d'ads (même user + account)
   */
  private async processAdGroup(
    key: string,
    ads: AdWithStopLoss[]
  ): Promise<void> {
    const [userId, accountId] = key.split(':');
    
    try {
      // Vérifier le quota avant de continuer
      const canMakeRequest = await rateLimitManager.canMakeRequest(userId, accountId);
      if (!canMakeRequest) {
        const waitTime = await rateLimitManager.getWaitTime(userId, accountId);
        if (waitTime > 0) {
          console.log(`⏳ Quota limit near, waiting ${waitTime}ms for ${key}`);
          await this.sleep(waitTime);
        }
      }

      // Récupérer le token Facebook de l'utilisateur
      const token = await this.getUserToken(userId);
      if (!token) {
        console.warn(`⚠️ No token found for user ${userId}`);
        return;
      }

      // Extraire les IDs des ads
      const adIds = ads.map(ad => ad.ad_id);

      // Utiliser Meta Batch API pour récupérer SEULEMENT spend et actions
      // C'est optimisé : un seul appel batch pour toutes les ads au lieu de N appels
      console.log(`📦 Fetching insights for ${adIds.length} ads using batch API (${key})`);
      
      const insightsMap = await metaBatchAPI.fetchStopLossInsights(
        token,
        adIds,
        userId,
        accountId,
        'today' // Seulement les données d'aujourd'hui pour le stop-loss
      );

      // Traiter chaque ad
      const processedAds: ProcessedAd[] = [];

      console.log(`🔍 [Batch] Insights map contains ${insightsMap.size} entries`);
      console.log(`🔍 [Batch] Insights map keys:`, Array.from(insightsMap.keys()));

      for (const ad of ads) {
        console.log(`🔍 [Batch] Looking for metrics for ad ${ad.ad_id}`);
        const metrics = insightsMap.get(ad.ad_id);
        
        if (!metrics) {
          console.error(`❌ [Batch] No metrics found for ad ${ad.ad_id}`);
          console.error(`❌ [Batch] Available keys in map:`, Array.from(insightsMap.keys()));
          console.error(`❌ [Batch] Ad ID type: ${typeof ad.ad_id}, value: ${ad.ad_id}`);
          // Ajouter à la retry queue
          await this.addToRetryQueue(userId, ad.ad_id, 'No metrics returned');
          continue;
        }
        
        console.log(`✅ [Batch] Metrics found for ad ${ad.ad_id}: spend=$${metrics.spend}, results=${metrics.results}`);

        // Vérifier les conditions de stop-loss
        console.log(`🔍 [Batch] Evaluating stop-loss for ad ${ad.ad_id}: spend=$${metrics.spend.toFixed(2)}, results=${metrics.results}`);
        console.log(`🔍 [Batch] Thresholds: cost_per_result=${ad.cost_per_result_threshold}, zero_results_spend=${ad.zero_results_spend_threshold}`);
        console.log(`🔍 [Batch] Thresholds enabled: cpr_enabled=${ad.cpr_enabled}, zero_results_enabled=${ad.zero_results_enabled}`);
        console.log(`🔍 [Batch] Ad enabled: ${ad.enabled}`);
        
        const shouldStop = this.evaluateStopConditions(
          metrics,
          ad.cost_per_result_threshold,
          ad.zero_results_spend_threshold,
          ad.cpr_enabled,
          ad.zero_results_enabled
        );

        console.log(`🔍 [Batch] Should stop for ad ${ad.ad_id}: ${shouldStop}`);
        
        if (shouldStop) {
          console.log(`🛑 [Batch] Stop-loss triggered for ad ${ad.ad_id}: ${this.getStopReason(metrics, ad)}`);
        } else {
          console.log(`✅ [Batch] No stop-loss trigger for ad ${ad.ad_id} - conditions not met`);
        }

        // Calculer les valeurs pour la notification et le log
        let threshold: number | undefined;
        let actualValue: number | undefined;
        
        if (shouldStop) {
          if (ad.cpr_enabled && ad.cost_per_result_threshold && metrics.results > 0) {
            const costPerResult = metrics.spend / metrics.results;
            if (costPerResult >= ad.cost_per_result_threshold) {
              threshold = ad.cost_per_result_threshold;
              actualValue = costPerResult;
            }
          } else if (ad.zero_results_enabled && ad.zero_results_spend_threshold && metrics.results === 0) {
            threshold = ad.zero_results_spend_threshold;
            actualValue = metrics.spend;
          }
        }
        
        processedAds.push({
          adId: ad.ad_id,
          userId: ad.user_id,
          accountId: ad.account_id,
          metrics,
          shouldStop,
          reason: shouldStop ? this.getStopReason(metrics, ad) : undefined,
          adName: undefined, // Sera récupéré plus tard depuis stop_loss_settings
          threshold,
          actualValue,
          costPerResultThreshold: ad.cost_per_result_threshold,
          zeroResultsSpendThreshold: ad.zero_results_spend_threshold
        });
      }

      // Mettre en pause les ads qui doivent être arrêtées
      const adsToPause = processedAds.filter(ad => ad.shouldStop);
      
      console.log(`🔍 [Batch] Processed ${processedAds.length} ads, ${adsToPause.length} need to be paused`);
      
      if (adsToPause.length > 0) {
        console.log(`🛑 [Batch] Pausing ${adsToPause.length} ads due to stop-loss triggers:`);
        adsToPause.forEach(ad => {
          console.log(`  - Ad ${ad.adId}: ${ad.reason}`);
        });
        await this.pauseAdsInBatch(token, adsToPause, userId, accountId);
      } else {
        console.log(`✅ [Batch] No ads to pause for group ${key}`);
      }

    } catch (error) {
      console.error(`❌ Error processing ad group ${key}:`, error);
      // Ajouter toutes les ads de ce groupe à la retry queue
      for (const ad of ads) {
        await this.addToRetryQueue(ad.user_id, ad.ad_id, (error as Error).message);
      }
    }
  }

  /**
   * Évaluer les conditions de stop-loss
   */
  private evaluateStopConditions(
    metrics: AdMetrics,
    costPerResultThreshold?: number,
    zeroResultsSpendThreshold?: number,
    cprEnabled: boolean = true,
    zeroResultsEnabled: boolean = true
  ): boolean {
    const { spend, results } = metrics;

    // S'assurer que les seuils sont bien des nombres
    const cprThreshold = costPerResultThreshold ? parseFloat(String(costPerResultThreshold)) : null;
    const zrsThreshold = zeroResultsSpendThreshold ? parseFloat(String(zeroResultsSpendThreshold)) : null;

    console.log(`🔍 Evaluating stop conditions: spend=$${spend.toFixed(2)}, results=${results}`);
    console.log(`🔍 Thresholds: costPerResult=${cprThreshold}, zeroResultsSpend=${zrsThreshold}`);
    console.log(`🔍 Thresholds enabled: cpr_enabled=${cprEnabled}, zero_results_enabled=${zeroResultsEnabled}`);
    console.log(`🔍 Types: spend=${typeof spend}, cprThreshold=${typeof cprThreshold}, zrsThreshold=${typeof zrsThreshold}`);

    // Condition 1: Coût par résultat dépassé (seulement si le seuil est activé)
    if (cprThreshold !== null && results > 0 && cprEnabled) {
      const costPerResult = spend / results;
      console.log(`🔍 Cost per result: $${costPerResult.toFixed(2)} vs threshold: $${cprThreshold}`);
      console.log(`🔍 Comparison: ${costPerResult} >= ${cprThreshold} = ${costPerResult >= cprThreshold}`);
      if (costPerResult >= cprThreshold) {
        return true;
      }
    }

    // Condition 2: Dépense sans résultats dépassée (seulement si le seuil est activé)
    if (zrsThreshold !== null && results === 0 && zeroResultsEnabled) {
      console.log(`🔍 Zero results spend: $${spend.toFixed(2)} vs threshold: $${zrsThreshold}`);
      console.log(`🔍 Comparison: ${spend} >= ${zrsThreshold} = ${spend >= zrsThreshold}`);
      if (spend >= zrsThreshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Obtenir la raison du stop
   */
  private getStopReason(
    metrics: AdMetrics,
    ad: AdWithStopLoss
  ): string {
    const { spend, results } = metrics;

    // Vérifier Cost Per Result (seulement si activé)
    if (ad.cpr_enabled && ad.cost_per_result_threshold && results > 0) {
      const costPerResult = spend / results;
      if (costPerResult >= ad.cost_per_result_threshold) {
        return `Cost per result $${costPerResult.toFixed(2)} >= $${ad.cost_per_result_threshold} (CPR threshold enabled)`;
      }
    }

    // Vérifier Zero Results Spend (seulement si activé)
    if (ad.zero_results_enabled && ad.zero_results_spend_threshold && results === 0 && spend >= ad.zero_results_spend_threshold) {
      return `Spent $${spend.toFixed(2)} with zero results (threshold: $${ad.zero_results_spend_threshold}, Zero Results threshold enabled)`;
    }

    return 'Unknown reason';
  }

  /**
   * Mettre en pause plusieurs ads en batch
   */
  private async pauseAdsInBatch(
    token: string,
    ads: ProcessedAd[],
    userId: string,
    accountId: string
  ): Promise<void> {
    const adIds = ads.map(ad => ad.adId);
    
    try {
      // Utiliser batch API pour mettre en pause toutes les ads en un seul appel
      const pauseResults = await metaBatchAPI.pauseAdsBatch(
        token,
        adIds,
        userId,
        accountId
      );

      // Créer des notifications et logs pour chaque ad, et désactiver le stop-loss
      for (const ad of ads) {
        const success = pauseResults.get(ad.adId);
        
        console.log(`🔍 [Batch] Pause result for ad ${ad.adId}: ${success ? 'SUCCESS' : 'FAILED'}`);
        
        if (success) {
          console.log(`✅ [Batch] Ad ${ad.adId} paused successfully. Reason: ${ad.reason}`);
          
          // 1. Récupérer le nom de l'ad depuis stop_loss_settings
          let adName: string | undefined;
          try {
            const supabaseAdmin = getSupabaseAdminClient();
            const { data: stopLossData, error: fetchError } = await (supabaseAdmin
              .from('stop_loss_settings') as any)
              .select('ad_name')
              .eq('ad_id', ad.adId)
              .eq('user_id', ad.userId)
              .maybeSingle();
            
            if (fetchError) {
              console.warn(`⚠️ [Batch] Could not fetch ad name for ${ad.adId}:`, fetchError);
            } else if (stopLossData) {
              adName = (stopLossData as any).ad_name || undefined;
              console.log(`✅ [Batch] Fetched ad name for ${ad.adId}: ${adName}`);
            }
          } catch (error) {
            console.warn(`⚠️ [Batch] Exception fetching ad name for ${ad.adId}:`, error);
          }
          
          // 2. Désactiver le stop-loss pour arrêter le batch (économiser les appels API)
          try {
            const supabaseAdmin = getSupabaseAdminClient();
            const { data: updateData, error: disableError } = await (supabaseAdmin
              .from('stop_loss_settings') as any)
              .update({ 
                enabled: false,
                updated_at: new Date().toISOString()
              })
              .eq('ad_id', ad.adId)
              .eq('user_id', ad.userId)
              .select();
            
            if (disableError) {
              console.error(`❌ [Batch] Error disabling stop-loss for ad ${ad.adId}:`, disableError);
              console.error(`❌ [Batch] Error details:`, JSON.stringify(disableError, null, 2));
            } else {
              console.log(`✅ [Batch] Stop-loss disabled for ad ${ad.adId} to stop batch monitoring`);
              console.log(`✅ [Batch] Updated config:`, JSON.stringify(updateData, null, 2));
            }
          } catch (error) {
            console.error(`⚠️ [Batch] Exception disabling stop-loss for ad ${ad.adId}:`, error);
            if (error instanceof Error) {
              console.error(`⚠️ [Batch] Error message:`, error.message);
              console.error(`⚠️ [Batch] Error stack:`, error.stack);
            }
          }
          
          // 3. Créer notification avec toutes les données (même si la désactivation a échoué)
          try {
            await this.createNotification(
              ad.userId, 
              ad.adId, 
              ad.metrics, 
              ad.reason!,
              adName,
              ad.threshold,
              ad.actualValue
            );
          } catch (notifError) {
            console.error(`❌ [Batch] Failed to create notification for ad ${ad.adId}:`, notifError);
            // Continuer même si la notification échoue
          }
          
          // 4. Logger l'événement avec toutes les données pour l'historique admin (même si la notification a échoué)
          try {
            await this.logStopLossEvent(
              ad.userId, 
              ad.adId, 
              ad.metrics, 
              ad.reason!,
              adName,
              ad.threshold,
              ad.actualValue
            );
          } catch (logError) {
            console.error(`❌ [Batch] Failed to log event for ad ${ad.adId}:`, logError);
            // Continuer même si le log échoue
          }
          
          console.log(`✅ [Batch] Completed all actions for ad ${ad.adId} (pause, disable, notification, log)`);
        } else {
          console.error(`❌ [Batch] Failed to pause ad ${ad.adId}`);
          // Échec, ajouter à retry queue
          await this.addToRetryQueue(ad.userId, ad.adId, 'Failed to pause ad');
        }
      }
    } catch (error) {
      console.error('❌ Error pausing ads in batch:', error);
      // Ajouter toutes les ads à la retry queue
      for (const ad of ads) {
        await this.addToRetryQueue(ad.userId, ad.adId, (error as Error).message);
      }
    }
  }

  /**
   * Récupérer le token Facebook d'un utilisateur
   */
  private async getUserToken(userId: string): Promise<string | null> {
    try {
      const { data, error } = await (supabase
        .from('access_tokens') as any)
        .select('token')
        .eq('userId', userId)
        .single();

      if (error || !data) return null;
      return (data as any).token;
    } catch (error) {
      console.error(`❌ Error fetching token for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Ajouter une ad à la retry queue
   */
  private async addToRetryQueue(
    userId: string,
    adId: string,
    errorMessage: string
  ): Promise<void> {
    try {
      const { error } = await (supabase
        .from('stop_loss_retry_queue') as any)
        .upsert({
          user_id: userId,
          ad_id: adId,
          error_message: errorMessage,
          retry_count: 0,
          max_retries: this.config?.max_retries || 3,
          next_retry_at: new Date(Date.now() + (this.config?.retry_delay_base_ms || 1000)).toISOString(),
          status: 'pending'
        }, {
          onConflict: 'user_id,ad_id'
        });

      if (error) {
        console.warn(`⚠️ Error adding to retry queue:`, error);
      }
    } catch (error) {
      console.warn(`⚠️ Error in addToRetryQueue:`, error);
    }
  }

  /**
   * Créer une notification pour l'utilisateur avec toutes les données
   */
  private async createNotification(
    userId: string,
    adId: string,
    metrics: AdMetrics,
    reason: string,
    adName?: string,
    threshold?: number,
    actualValue?: number
  ): Promise<void> {
    try {
      const triggeredAt = new Date().toISOString();
      const costPerResult = metrics.results > 0 ? metrics.spend / metrics.results : null;
      
      // Utiliser le client admin pour contourner les RLS policies
      const supabaseAdmin = getSupabaseAdminClient();
      
      console.log(`🔔 [Notification] Creating notification for user ${userId}, ad ${adId}`);
      console.log(`🔔 [Notification] Metrics: spend=${metrics.spend}, results=${metrics.results}`);
      console.log(`🔔 [Notification] Reason: ${reason}, threshold=${threshold}, actualValue=${actualValue}`);
      
      const notificationData = {
        user_id: userId,
        type: 'stop_loss',
        title: '🛑 Stop Loss Déclenché',
        message: `La publicité "${adName || adId}" a été arrêtée automatiquement.`,
        data: {
          ad_id: adId,
          ad_name: adName || adId,
          spend: metrics.spend,
          results: metrics.results,
          cost_per_result: costPerResult,
          reason: reason,
          threshold: threshold,
          actual_value: actualValue || costPerResult || metrics.spend,
          triggered_at: triggeredAt,
          triggered_by: 'optimized_batch_service'
        },
        is_read: false
      };
      
      console.log(`🔔 [Notification] Notification data:`, JSON.stringify(notificationData, null, 2));
      
      const { data, error } = await (supabaseAdmin.from('notifications') as any).insert(notificationData).select();

      if (error) {
        console.error(`❌ [Notification] Error creating notification for ad ${adId}:`, error);
        console.error(`❌ [Notification] Error details:`, JSON.stringify(error, null, 2));
        console.error(`❌ [Notification] Error code:`, error.code);
        console.error(`❌ [Notification] Error message:`, error.message);
        throw error; // Propager l'erreur pour qu'elle soit gérée par le try-catch parent
      } else {
        console.log(`✅ [Notification] Notification created successfully for ad ${adId}`);
        console.log(`✅ [Notification] Created notification ID:`, data?.[0]?.id);
        console.log(`✅ [Notification] Notification saved in database:`, JSON.stringify(data?.[0], null, 2));
        
        // Vérifier que la notification est bien enregistrée
        if (data && data[0] && data[0].id) {
          console.log(`✅ [Notification] ✅ VERIFIED: Notification ${data[0].id} is saved in database`);
        } else {
          console.warn(`⚠️ [Notification] WARNING: Notification may not be saved (no ID returned)`);
        }
      }
    } catch (error) {
      console.error(`⚠️ [Notification] Exception creating notification:`, error);
      if (error instanceof Error) {
        console.error(`⚠️ [Notification] Error message:`, error.message);
        console.error(`⚠️ [Notification] Error stack:`, error.stack);
      }
    }
  }

  /**
   * Logger l'événement stop-loss avec toutes les données pour l'historique admin
   */
  private async logStopLossEvent(
    userId: string,
    adId: string,
    metrics: AdMetrics,
    reason: string,
    adName?: string,
    threshold?: number,
    actualValue?: number
  ): Promise<void> {
    try {
      const triggeredAt = new Date().toISOString();
      const costPerResult = metrics.results > 0 ? metrics.spend / metrics.results : null;
      
      // Utiliser le client admin pour contourner les RLS policies
      const supabaseAdmin = getSupabaseAdminClient();
      
      console.log(`📝 [Log] Logging stop-loss event for user ${userId}, ad ${adId}`);
      console.log(`📝 [Log] Metrics: spend=${metrics.spend}, results=${metrics.results}`);
      console.log(`📝 [Log] Reason: ${reason}, threshold=${threshold}, actualValue=${actualValue}`);
      
      const logData = {
        user_id: userId,
        action: 'STOP_LOSS_TRIGGERED',
        details: {
          adId: adId,
          ad_id: adId,
          adName: adName || adId,
          ad_name: adName || adId,
          spend: metrics.spend,
          results: metrics.results,
          cost_per_result: costPerResult,
          reason: reason,
          threshold: threshold,
          actualValue: actualValue || costPerResult || metrics.spend,
          actual_value: actualValue || costPerResult || metrics.spend,
          triggeredAt: triggeredAt,
          triggered_at: triggeredAt,
          triggeredBy: 'optimized_batch_service',
          triggered_by: 'optimized_batch_service'
        }
      };
      
      console.log(`📝 [Log] Log data:`, JSON.stringify(logData, null, 2));
      
      const { data, error } = await (supabaseAdmin.from('logs') as any).insert(logData).select();

      if (error) {
        console.error(`❌ [Log] Error logging stop-loss event for ad ${adId}:`, error);
        console.error(`❌ [Log] Error details:`, JSON.stringify(error, null, 2));
        console.error(`❌ [Log] Error code:`, error.code);
        console.error(`❌ [Log] Error message:`, error.message);
        throw error; // Propager l'erreur pour qu'elle soit gérée par le try-catch parent
      } else {
        console.log(`✅ [Log] Stop-loss event logged successfully for ad ${adId}`);
        console.log(`✅ [Log] Created log ID:`, data?.[0]?.id);
        console.log(`✅ [Log] Log saved in database:`, JSON.stringify(data?.[0], null, 2));
        
        // Vérifier que le log est bien enregistré
        if (data && data[0] && data[0].id) {
          console.log(`✅ [Log] ✅ VERIFIED: Log ${data[0].id} is saved in database`);
        } else {
          console.warn(`⚠️ [Log] WARNING: Log may not be saved (no ID returned)`);
        }
      }
    } catch (error) {
      console.error(`⚠️ [Log] Exception logging stop-loss event:`, error);
      if (error instanceof Error) {
        console.error(`⚠️ [Log] Error message:`, error.message);
        console.error(`⚠️ [Log] Error stack:`, error.stack);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const optimizedStopLossService = new OptimizedStopLossService();
export default optimizedStopLossService;

