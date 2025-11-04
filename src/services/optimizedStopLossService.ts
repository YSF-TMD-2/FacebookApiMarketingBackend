import { supabase } from '../supabaseClient.js';
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
      const { data, error } = await supabase
        .from('system_settings')
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

      this.config = data.value as BatchConfig;
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

    this.isRunning = true;
    console.log(`🚀 Starting optimized stop-loss service (interval: ${this.config.batch_interval_ms}ms)`);

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
        console.log('📭 No ads with stop-loss enabled');
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
      const { data, error } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('enabled', true);

      if (error) throw error;

      return (data || []).map(item => ({
        ad_id: item.ad_id,
        user_id: item.user_id,
        account_id: item.account_id,
        cost_per_result_threshold: item.cost_per_result_threshold,
        zero_results_spend_threshold: item.zero_results_spend_threshold,
        enabled: item.enabled
      }));
    } catch (error) {
      console.error('❌ Error fetching ads with stop-loss:', error);
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

      const { data: batchConfigs, error } = await supabase
        .from('user_batch_config')
        .select('user_id, enabled')
        .in('user_id', userIds);

      if (error) {
        console.warn('⚠️ Error fetching user batch configs, proceeding with all users:', error);
        return groupedAds;
      }

      // Créer un map user_id -> enabled
      const userEnabledMap = new Map<string, boolean>();
      batchConfigs?.forEach(config => {
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

      for (const ad of ads) {
        const metrics = insightsMap.get(ad.ad_id);
        
        if (!metrics) {
          console.warn(`⚠️ No metrics found for ad ${ad.ad_id}`);
          // Ajouter à la retry queue
          await this.addToRetryQueue(userId, ad.ad_id, 'No metrics returned');
          continue;
        }

        // Vérifier les conditions de stop-loss
        const shouldStop = this.evaluateStopConditions(
          metrics,
          ad.cost_per_result_threshold,
          ad.zero_results_spend_threshold
        );

        processedAds.push({
          adId: ad.ad_id,
          userId: ad.user_id,
          accountId: ad.account_id,
          metrics,
          shouldStop,
          reason: shouldStop ? this.getStopReason(metrics, ad) : undefined
        });
      }

      // Mettre en pause les ads qui doivent être arrêtées
      const adsToPause = processedAds.filter(ad => ad.shouldStop);
      
      if (adsToPause.length > 0) {
        console.log(`🛑 Pausing ${adsToPause.length} ads due to stop-loss triggers`);
        await this.pauseAdsInBatch(token, adsToPause, userId, accountId);
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
    zeroResultsSpendThreshold?: number
  ): boolean {
    const { spend, results } = metrics;

    // Condition 1: Coût par résultat dépassé
    if (costPerResultThreshold && results > 0) {
      const costPerResult = spend / results;
      if (costPerResult >= costPerResultThreshold) {
        return true;
      }
    }

    // Condition 2: Dépense sans résultats dépassée
    if (zeroResultsSpendThreshold && results === 0 && spend >= zeroResultsSpendThreshold) {
      return true;
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

    if (ad.cost_per_result_threshold && results > 0) {
      const costPerResult = spend / results;
      if (costPerResult >= ad.cost_per_result_threshold) {
        return `Cost per result ${costPerResult.toFixed(2)} >= ${ad.cost_per_result_threshold}`;
      }
    }

    if (ad.zero_results_spend_threshold && results === 0 && spend >= ad.zero_results_spend_threshold) {
      return `Spent $${spend.toFixed(2)} with zero results (threshold: $${ad.zero_results_spend_threshold})`;
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

      // Créer des notifications et logs pour chaque ad
      for (const ad of ads) {
        const success = pauseResults.get(ad.adId);
        
        if (success) {
          // Créer notification
          await this.createNotification(ad.userId, ad.adId, ad.metrics, ad.reason!);
          
          // Logger l'événement
          await this.logStopLossEvent(ad.userId, ad.adId, ad.metrics, ad.reason!);
        } else {
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
      const { data, error } = await supabase
        .from('access_tokens')
        .select('token')
        .eq('userId', userId)
        .single();

      if (error || !data) return null;
      return data.token;
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
      const { error } = await supabase
        .from('stop_loss_retry_queue')
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
   * Créer une notification pour l'utilisateur
   */
  private async createNotification(
    userId: string,
    adId: string,
    metrics: AdMetrics,
    reason: string
  ): Promise<void> {
    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        type: 'stop_loss',
        title: 'Stop Loss Triggered',
        message: `Ad ${adId} was paused automatically. Reason: ${reason}`,
        data: {
          ad_id: adId,
          spend: metrics.spend,
          results: metrics.results,
          reason,
          triggered_at: new Date().toISOString()
        },
        is_read: false
      });
    } catch (error) {
      console.warn(`⚠️ Error creating notification:`, error);
    }
  }

  /**
   * Logger l'événement stop-loss
   */
  private async logStopLossEvent(
    userId: string,
    adId: string,
    metrics: AdMetrics,
    reason: string
  ): Promise<void> {
    try {
      await supabase.from('logs').insert({
        user_id: userId,
        action: 'STOP_LOSS_TRIGGERED',
        details: {
          ad_id: adId,
          spend: metrics.spend,
          results: metrics.results,
          reason
        }
      });
    } catch (error) {
      console.warn(`⚠️ Error logging stop-loss event:`, error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const optimizedStopLossService = new OptimizedStopLossService();
export default optimizedStopLossService;

