import { createClient } from '@supabase/supabase-js';

interface AdActivity {
  adId: string;
  userId: string;
  spend: number;
  results: number;
  lastUpdate: number;
  activityLevel: 'high' | 'normal' | 'low';
  errorCount: number;
  lastError?: string;
}

interface CachedMetrics {
  data: any;
  timestamp: number;
  ttl: number;
}

interface StopLossConfig {
  pollingEnabled: boolean;
  adaptiveIntervals: {
    highActivity: number;
    normalActivity: number;
    lowActivity: number;
  };
  maxRetries: number;
  retryDelay: number;
  cacheTTL: number;
}

class HybridStopLossService {
  private config: StopLossConfig;
  private activeAds: Map<string, AdActivity> = new Map();
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private adMetricsCache: Map<string, CachedMetrics> = new Map();
  private errorLog: Array<{ timestamp: number; error: string; context: any }> = [];
  private supabase: any;

  constructor(config: StopLossConfig) {
    this.config = config;
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );
    this.initializeServices();
  }

  // Initialisation des services
  private async initializeServices() {
    try {
      if (this.config.pollingEnabled) {
        await this.setupIntelligentPolling();
        console.log('✅ Polling intelligent configuré');
      }

      // Nettoyage périodique du cache
      setInterval(() => this.cleanupCache(), 300000); // 5 minutes
      
      console.log('🚀 Service Stop Loss initialisé');
    } catch (error) {
      this.logError('Erreur lors de l\'initialisation', { error: error.message });
      throw error;
    }
  }

  // Résolution du user_id à partir de l'ad_id
  private async resolveUserIdFromAdId(adId: string): Promise<string | null> {
    try {
      // Chercher l'annonce dans la base de données
      const { data, error } = await this.supabase
        .from('ads')
        .select('user_id')
        .eq('id', adId)
        .single();

      if (error) {
        // Si l'annonce n'existe pas en base, chercher dans stop_loss_settings
        const { data: stopLossData } = await this.supabase
          .from('stop_loss_settings')
          .select('user_id')
          .eq('ad_id', adId)
          .single();

        return stopLossData?.user_id || null;
      }

      return data?.user_id || null;
    } catch (error) {
      this.logError('Erreur résolution user_id', { adId, error: error.message });
      return null;
    }
  }

  // Traitement des insights d'annonce
  private async processAdInsightsUpdate(insights: any) {
    try {
      const { ad_id, spend, results, user_id } = insights;
      
      if (!ad_id) {
        throw new Error('ad_id manquant dans les données');
      }

      // Récupérer le user_id si manquant
      const resolvedUserId = user_id || await this.resolveUserIdFromAdId(ad_id);
      
      if (!resolvedUserId) {
        throw new Error('user_id introuvable pour cette annonce');
      }

      // Mise à jour de l'activité
      this.updateAdActivity(ad_id, { 
        spend: parseFloat(spend) || 0, 
        results: parseInt(results) || 0,
        userId: resolvedUserId
      });
      
      // Vérification immédiate
      await this.checkStopLossImmediate(ad_id, resolvedUserId, spend, results);
      
      console.log(`✅ Insights traités pour l'annonce ${ad_id}`);
    } catch (error) {
      this.logError('Erreur traitement insights', { 
        insights, 
        error: error.message 
      });
    }
  }

  // Traitement des changements de statut
  private async processAdStatusUpdate(statusData: any) {
    try {
      const { ad_id, status, user_id } = statusData;
      
      if (!ad_id || !user_id) {
        throw new Error('Données de statut incomplètes');
      }

      // Mise à jour du statut
      this.updateAdStatus(ad_id, status);
      
      console.log(`✅ Statut mis à jour pour l'annonce ${ad_id}: ${status}`);
    } catch (error) {
      this.logError('Erreur traitement statut', { 
        status, 
        error: error.message 
      });
    }
  }

  // Traitement des changements de compte
  private async processAdAccountUpdate(account: any) {
    try {
      const { account_id, user_id } = account;
      
      if (!account_id || !user_id) {
        throw new Error('Données de compte incomplètes');
      }

      // Mise à jour des annonces du compte
      await this.updateAccountAds(account_id, user_id);
      
      console.log(`✅ Compte mis à jour: ${account_id}`);
    } catch (error) {
      this.logError('Erreur traitement compte', { 
        account, 
        error: error.message 
      });
    }
  }

  // Mise à jour de l'activité d'une annonce
  private updateAdActivity(adId: string, data: { spend: number; results: number; userId: string }) {
    const existing = this.activeAds.get(adId) || {
      adId,
      userId: data.userId,
      spend: 0,
      results: 0,
      lastUpdate: 0,
      activityLevel: 'low' as const,
      errorCount: 0
    };

    const updated: AdActivity = {
      ...existing,
      spend: data.spend,
      results: data.results,
      lastUpdate: Date.now(),
      activityLevel: this.calculateActivityLevel(data.spend, data.results),
      errorCount: 0 // Reset error count on successful update
    };

    this.activeAds.set(adId, updated);
  }

  // Calcul du niveau d'activité
  private calculateActivityLevel(spend: number, results: number): 'high' | 'normal' | 'low' {
    if (spend > 100 || results > 10) return 'high';
    if (spend > 10 || results > 1) return 'normal';
    return 'low';
  }


  // Mise à jour des annonces d'un compte
  private async updateAccountAds(accountId: string, userId: string) {
    try {
      // Récupérer les annonces du compte
      const { data: ads, error } = await this.supabase
        .from('ads')
        .select('id, status, spend, results')
        .eq('account_id', accountId)
        .eq('user_id', userId);

      if (error) throw error;

      // Mettre à jour l'activité
      for (const ad of ads || []) {
        this.updateAdActivity(ad.id, {
          spend: ad.spend || 0,
          results: ad.results || 0,
          userId
        });
      }
    } catch (error) {
      this.logError('Erreur mise à jour compte', { 
        accountId, 
        userId, 
        error: error.message 
      });
    }
  }

  // Vérification immédiate du stop loss
  private async checkStopLossImmediate(adId: string, userId: string, spend: number, results: number) {
    try {
      // Récupérer la configuration stop loss pour cette ad spécifique
      const stopLossConfig = await this.getAdStopLossConfig(adId, userId);
      if (!stopLossConfig || !stopLossConfig.enabled) {
        console.log(`⚠️ Aucune configuration stop loss trouvée pour l'annonce ${adId}`);
        return;
      }

      // Vérifier les conditions
      const shouldStop = this.evaluateStopConditions(spend, results, stopLossConfig);
      
      if (shouldStop) {
        await this.executeStopLoss(adId, userId, spend, results, stopLossConfig);
      }
    } catch (error) {
      this.logError('Erreur vérification stop loss', { 
        adId, 
        userId, 
        error: error.message 
      });
    }
  }

  // Récupération de la configuration stop loss pour une ad spécifique
  private async getAdStopLossConfig(adId: string, userId: string): Promise<any> {
    try {
      const { data, error } = await this.supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .eq('enabled', true)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.logError('Erreur récupération configuration stop loss', { 
        adId,
        userId, 
        error: error.message 
      });
      return null;
    }
  }

  // Évaluation des conditions de stop
  private evaluateStopConditions(spend: number, results: number, stopLossConfig: any): boolean {
    try {
      // Condition 1: Coût par résultat
      if (results > 0 && stopLossConfig.cost_per_result_threshold) {
        const costPerResult = spend / results;
        if (costPerResult >= stopLossConfig.cost_per_result_threshold) {
          console.log(`🚨 Stop loss déclenché: Coût par résultat ${costPerResult} >= ${stopLossConfig.cost_per_result_threshold}`);
          return true;
        }
      }
      
      // Condition 2: Dépense sans résultats
      if (results === 0 && stopLossConfig.zero_results_spend_threshold && spend >= stopLossConfig.zero_results_spend_threshold) {
        console.log(`🚨 Stop loss déclenché: Dépense ${spend} >= ${stopLossConfig.zero_results_spend_threshold} sans résultats`);
        return true;
      }
      
      return false;
    } catch (error) {
      this.logError('Erreur évaluation conditions', { 
        spend, 
        results, 
        stopLossConfig, 
        error: error.message 
      });
      return false;
    }
  }

  // Exécution du stop loss
  private async executeStopLoss(adId: string, userId: string, spend: number, results: number, stopLossConfig: any) {
    try {
      console.log(`🛑 Exécution stop loss pour l'annonce ${adId}`);
      
      // 1. Arrêter l'annonce
      await this.stopAd(adId, userId);
      
      // 2. Créer une notification
      await this.createStopLossNotification(adId, userId, spend, results, stopLossConfig);
      
      // 3. Logger l'événement
      this.logStopLossEvent(adId, userId, spend, results, stopLossConfig);
      
      // 4. Nouveau : Programmer la réactivation automatique si activée
      if (stopLossConfig.auto_activate_enabled) {
        const delayMinutes = stopLossConfig.auto_activate_delay_minutes || 60;
        const delayMs = delayMinutes * 60 * 1000;
        
        console.log(`⏰ Réactivation automatique programmée dans ${delayMinutes} minutes`);
        
        setTimeout(async () => {
          await this.activateAd(adId, userId, stopLossConfig);
        }, delayMs);
      }
      
      console.log(`✅ Stop loss exécuté avec succès pour l'annonce ${adId}`);
    } catch (error) {
      this.logError('Erreur exécution stop loss', { 
        adId, 
        userId, 
        error: error.message 
      });
    }
  }

  // Activation automatique d'une annonce
  private async activateAd(adId: string, userId: string, stopLossConfig: any) {
    try {
      console.log(`🟢 Réactivation automatique de l'annonce ${adId}`);
      
      // 1. Récupérer le token Facebook de l'utilisateur
      const { data: tokenRow, error: tokenError } = await this.supabase
        .from('access_tokens')
        .select('token')
        .eq('userId', userId)
        .single();

      if (tokenError || !tokenRow?.token) {
        throw new Error('Token Facebook non trouvé pour cet utilisateur');
      }

      // 2. Réactiver l'annonce sur Facebook
      // Facebook Graph API nécessite le token dans l'URL, pas dans le body
      const fbResponse = await fetch(
        `https://graph.facebook.com/v18.0/${adId}?access_token=${tokenRow.token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'ACTIVE'
          })
        }
      );

      const fbResult = await fbResponse.json();
      
      if (fbResult.error) {
        throw new Error(`Facebook API error: ${fbResult.error.message}`);
      }

      console.log(`✅ Annonce ${adId} réactivée sur Facebook`);

      // 3. Mettre à jour la base de données locale
      const { error } = await this.supabase
        .from('ads')
        .update({ 
          status: 'ACTIVE',
          stop_loss_triggered: false,
          stop_loss_date: null
        })
        .eq('id', adId)
        .eq('user_id', userId);

      if (error) throw error;
      
      console.log(`✅ Annonce ${adId} activée en base de données`);

      // 4. Créer une notification
      await this.supabase
        .from('notifications')
        .insert({
          user_id: userId,
          type: 'info',
          title: 'Annonce Réactivée Automatiquement',
          message: `L'annonce ${adId} a été réactivée automatiquement après ${stopLossConfig.auto_activate_delay_minutes || 60} minutes`,
          data: {
            ad_id: adId,
            reactivated_at: new Date().toISOString(),
            auto_activate: true
          },
          is_read: false
        });

      console.log(`✅ Notification créée pour la réactivation de ${adId}`);
    } catch (error) {
      this.logError('Erreur réactivation annonce', { 
        adId, 
        userId, 
        error: error.message 
      });
      throw error;
    }
  }

  // Arrêt d'une annonce
  private async stopAd(adId: string, userId: string) {
    try {
      // 1. Récupérer le token Facebook de l'utilisateur
      const { data: tokenRow, error: tokenError } = await this.supabase
        .from('access_tokens')
        .select('token')
        .eq('userId', userId)
        .single();

      if (tokenError || !tokenRow?.token) {
        throw new Error('Token Facebook non trouvé pour cet utilisateur');
      }

      // 2. CRITIQUE : Mettre à jour l'annonce sur Facebook d'abord
      // Facebook Graph API nécessite le token dans l'URL, pas dans le body
      const fbResponse = await fetch(
        `https://graph.facebook.com/v18.0/${adId}?access_token=${tokenRow.token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'PAUSED'
          })
        }
      );

      const fbResult = await fbResponse.json();
      
      if (fbResult.error) {
        throw new Error(`Facebook API error: ${fbResult.error.message}`);
      }

      console.log(`✅ Annonce ${adId} mise en pause sur Facebook`);

      // 3. Mettre à jour la base de données locale
      const { error } = await this.supabase
        .from('ads')
        .update({ 
          status: 'PAUSED',
          stop_loss_triggered: true,
          stop_loss_date: new Date().toISOString()
        })
        .eq('id', adId)
        .eq('user_id', userId);

      if (error) throw error;
      
      console.log(`✅ Annonce ${adId} arrêtée en base de données`);
    } catch (error) {
      this.logError('Erreur arrêt annonce', { 
        adId, 
        userId, 
        error: error.message 
      });
      throw error; // Propager l'erreur pour notifier l'utilisateur
    }
  }

  // Création d'une notification de stop loss
  private async createStopLossNotification(adId: string, userId: string, spend: number, results: number, stopLossConfig: any) {
    try {
      const { error } = await this.supabase
        .from('notifications')
        .insert({
          user_id: userId,
          type: 'stop_loss',
          title: 'Stop Loss Déclenché',
          message: `L'annonce ${adId} a été arrêtée automatiquement. Dépense: $${spend}, Résultats: ${results}`,
          data: {
            ad_id: adId,
            spend,
            results,
            stopLossConfig,
            triggered_at: new Date().toISOString()
          },
          is_read: false
        });

      if (error) throw error;
      
      console.log(`✅ Notification créée pour l'annonce ${adId}`);
    } catch (error) {
      this.logError('Erreur création notification', { 
        adId, 
        userId, 
        error: error.message 
      });
    }
  }

  // Logging de l'événement stop loss
  private logStopLossEvent(adId: string, userId: string, spend: number, results: number, stopLossConfig: any) {
    console.log(`📝 Événement stop loss déclenché:`, {
      ad_id: adId,
      user_id: userId,
      spend,
      results,
      stopLossConfig,
      timestamp: new Date().toISOString()
    });
  }

  // Configuration du polling intelligent
  private async setupIntelligentPolling() {
    try {
      // Polling initial pour toutes les annonces actives
      await this.initializePollingForActiveAds();
      
      // Ajustement périodique des intervalles
      setInterval(() => {
        this.adjustPollingIntervals();
      }, 300000); // Toutes les 5 minutes
      
      console.log('✅ Polling intelligent configuré');
    } catch (error) {
      this.logError('Erreur configuration polling', { error: error.message });
    }
  }

  // Initialisation du polling pour les annonces actives
  private async initializePollingForActiveAds() {
    try {
      // Vérifier si la table ads existe
      const { data: ads, error } = await this.supabase
        .from('ads')
        .select('id, user_id, status')
        .eq('status', 'ACTIVE');

      if (error) {
        if (error.message.includes('Could not find the table')) {
          console.log('⚠️ Table "ads" non trouvée. Le polling sera initialisé quand des annonces seront ajoutées.');
          return;
        }
        throw error;
      }

      for (const ad of ads || []) {
        await this.startPollingForAd(ad);
      }
      
      console.log(`✅ Polling initialisé pour ${ads?.length || 0} annonces actives`);
    } catch (error) {
      this.logError('Erreur initialisation polling', { error: error.message });
    }
  }

  // Démarrage du polling pour une annonce
  private async startPollingForAd(ad: any) {
    try {
      const interval = this.calculateOptimalInterval(ad);
      
      const pollingId = setInterval(async () => {
        await this.pollAdMetrics(ad);
      }, interval);
      
      this.pollingIntervals.set(ad.id, pollingId);
      console.log(`✅ Polling démarré pour l'annonce ${ad.id} (intervalle: ${interval}ms)`);
    } catch (error) {
      this.logError('Erreur démarrage polling', { adId: ad.id, error: error.message });
    }
  }

  // Calcul de l'intervalle optimal
  private calculateOptimalInterval(ad: any): number {
    const activity = this.getAdActivity(ad.id);
    
    if (activity > 5) {
      return this.config.adaptiveIntervals.highActivity;    // 1 min
    } else if (activity > 1) {
      return this.config.adaptiveIntervals.normalActivity;  // 5 min
    } else {
      return this.config.adaptiveIntervals.lowActivity;     // 30 min
    }
  }

  // Récupération de l'activité d'une annonce
  private getAdActivity(adId: string): number {
    const ad = this.activeAds.get(adId);
    if (!ad) return 0;
    
    const timeSinceLastUpdate = Date.now() - ad.lastUpdate;
    const hoursSinceUpdate = timeSinceLastUpdate / (1000 * 60 * 60);
    
    // Plus l'annonce est récente, plus elle est active
    return Math.max(0, 10 - hoursSinceUpdate);
  }

  // Polling des métriques d'une annonce
  private async pollAdMetrics(ad: any) {
    try {
      // Vérifier le cache d'abord
      const cached = this.getCachedMetrics(ad.id);
      if (cached) {
        console.log(`📊 Métriques en cache pour l'annonce ${ad.id}`);
        return;
      }

      // Récupérer les métriques depuis l'API Facebook
      const metrics = await this.fetchAdMetrics(ad.id, ad.user_id);
      
      // Mettre en cache
      this.cacheAdMetrics(ad.id, metrics);
      
      // Vérifier le stop loss
      await this.checkStopLossImmediate(ad.id, ad.user_id, metrics.spend, metrics.results);
      
    } catch (error) {
      this.logError('Erreur polling métriques', { 
        adId: ad.id, 
        error: error.message 
      });
      
      // Incrémenter le compteur d'erreurs
      this.incrementErrorCount(ad.id);
    }
  }

  // Récupération des métriques depuis l'API Facebook
  private async fetchAdMetrics(adId: string, userId: string): Promise<any> {
    try {
      // Récupérer le token d'accès utilisateur
      const { data: user, error } = await this.supabase
        .from('users')
        .select('facebook_access_token')
        .eq('id', userId)
        .single();

      if (error || !user?.facebook_access_token) {
        throw new Error('Token d\'accès Facebook non trouvé');
      }

      // Appel API Facebook
      const response = await fetch(
        `https://graph.facebook.com/v18.0/${adId}/insights?fields=spend,actions&access_token=${user.facebook_access_token}`
      );

      if (!response.ok) {
        throw new Error(`Erreur API Facebook: ${response.status}`);
      }

      const data = await response.json();
      
      return {
        spend: parseFloat(data.data?.[0]?.spend || '0'),
        results: parseInt(data.data?.[0]?.actions?.[0]?.value || '0'),
        timestamp: Date.now()
      };
    } catch (error) {
      this.logError('Erreur récupération métriques Facebook', { 
        adId, 
        userId, 
        error: error.message 
      });
      throw error;
    }
  }

  // Mise en cache des métriques
  private cacheAdMetrics(adId: string, metrics: any) {
    this.adMetricsCache.set(adId, {
      data: metrics,
      timestamp: Date.now(),
      ttl: this.config.cacheTTL
    });
  }

  // Récupération depuis le cache
  private getCachedMetrics(adId: string): any | null {
    const cached = this.adMetricsCache.get(adId);
    
    if (!cached) return null;
    
    // Vérifier si le cache est encore valide
    if (Date.now() - cached.timestamp > cached.ttl) {
      this.adMetricsCache.delete(adId);
      return null;
    }
    
    return cached.data;
  }

  // Incrémentation du compteur d'erreurs
  private incrementErrorCount(adId: string) {
    const ad = this.activeAds.get(adId);
    if (ad) {
      ad.errorCount++;
      ad.lastError = new Date().toISOString();
      this.activeAds.set(adId, ad);
      
      // Si trop d'erreurs, arrêter le polling
      if (ad.errorCount >= this.config.maxRetries) {
        this.stopPollingForAd(adId);
        console.log(`⚠️ Polling arrêté pour l'annonce ${adId} (trop d'erreurs)`);
      }
    }
  }

  // Arrêt du polling pour une annonce
  private stopPollingForAd(adId: string) {
    const interval = this.pollingIntervals.get(adId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(adId);
    }
  }

  // Ajustement dynamique des intervalles
  private adjustPollingIntervals() {
    try {
      for (const [adId, interval] of this.pollingIntervals) {
        const ad = this.activeAds.get(adId);
        if (!ad) continue;
        
        const newInterval = this.calculateOptimalInterval(ad);
        const currentInterval = this.getCurrentInterval(adId);
        
        if (newInterval !== currentInterval) {
          // Redémarrer avec le nouvel intervalle
          clearInterval(interval);
          this.startPollingForAd(ad);
        }
      }
    } catch (error) {
      this.logError('Erreur ajustement intervalles', { error: error.message });
    }
  }

  // Récupération de l'intervalle actuel
  private getCurrentInterval(adId: string): number {
    const ad = this.activeAds.get(adId);
    if (!ad) return this.config.adaptiveIntervals.lowActivity;
    
    return this.calculateOptimalInterval(ad);
  }

  // Nettoyage du cache
  private cleanupCache() {
    try {
      const now = Date.now();
      let cleaned = 0;
      
      for (const [adId, cached] of this.adMetricsCache) {
        if (now - cached.timestamp > cached.ttl) {
          this.adMetricsCache.delete(adId);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        console.log(`🧹 Cache nettoyé: ${cleaned} entrées supprimées`);
      }
    } catch (error) {
      this.logError('Erreur nettoyage cache', { error: error.message });
    }
  }

  // Logging des erreurs
  private logError(message: string, context: any) {
    const errorEntry = {
      timestamp: Date.now(),
      error: message,
      context
    };
    
    this.errorLog.push(errorEntry);
    console.error(`❌ ${message}:`, context);
    
    // Garder seulement les 1000 dernières erreurs
    if (this.errorLog.length > 1000) {
      this.errorLog = this.errorLog.slice(-1000);
    }
  }

  // Récupération des logs d'erreur
  public getErrorLogs(): Array<{ timestamp: number; error: string; context: any }> {
    return [...this.errorLog];
  }

  // Récupération des statistiques
  public getStats() {
    return {
      activeAds: this.activeAds.size,
      pollingIntervals: this.pollingIntervals.size,
      cacheSize: this.adMetricsCache.size,
      errorCount: this.errorLog.length,
      lastError: this.errorLog[this.errorLog.length - 1] || null
    };
  }

  // Ajouter une annonce au système de monitoring
  public async addAdToMonitoring(adId: string, userId: string, accountId: string, adName?: string) {
    try {
      // Vérifier si l'annonce existe déjà
      if (this.activeAds.has(adId)) {
        console.log(`⚠️ L'annonce ${adId} est déjà surveillée`);
        return;
      }

      // Ajouter à la base de données si elle existe
      try {
        const { error } = await this.supabase
          .from('ads')
          .insert({
            id: adId,
            user_id: userId,
            account_id: accountId,
            name: adName || `Ad ${adId}`,
            status: 'ACTIVE'
          });

        if (error && !error.message.includes('Could not find the table')) {
          throw error;
        }
      } catch (dbError) {
        console.log('⚠️ Table "ads" non disponible, ajout en mémoire seulement');
      }

      // Ajouter à la surveillance
      this.activeAds.set(adId, {
        adId,
        userId,
        spend: 0,
        results: 0,
        lastUpdate: Date.now(),
        activityLevel: 'low',
        errorCount: 0
      });

      // Démarrer le polling
      await this.startPollingForAd({ id: adId, user_id: userId, status: 'ACTIVE' });

      console.log(`✅ Annonce ${adId} ajoutée au système de monitoring`);
    } catch (error) {
      this.logError('Erreur ajout annonce', { adId, userId, error: error.message });
    }
  }

  // Retirer une annonce du système de monitoring
  public async removeAdFromMonitoring(adId: string) {
    try {
      // Arrêter le polling
      this.stopPollingForAd(adId);
      
      // Retirer de la surveillance
      this.activeAds.delete(adId);
      
      // Retirer du cache
      this.adMetricsCache.delete(adId);

      console.log(`✅ Annonce ${adId} retirée du système de monitoring`);
    } catch (error) {
      this.logError('Erreur retrait annonce', { adId, error: error.message });
    }
  }

  // Mettre à jour le statut d'une annonce
  public async updateAdStatus(adId: string, status: string) {
    try {
      const ad = this.activeAds.get(adId);
      if (!ad) {
        console.log(`⚠️ Annonce ${adId} non trouvée dans le système`);
        return;
      }

      // Mettre à jour en base si la table existe
      try {
        const { error } = await this.supabase
          .from('ads')
          .update({ status })
          .eq('id', adId)
          .eq('user_id', ad.userId);

        if (error && !error.message.includes('Could not find the table')) {
          throw error;
        }
      } catch (dbError) {
        console.log('⚠️ Table "ads" non disponible, mise à jour en mémoire seulement');
      }

      // Mettre à jour en mémoire
      ad.lastUpdate = Date.now();
      this.activeAds.set(adId, ad);

      console.log(`✅ Statut de l'annonce ${adId} mis à jour: ${status}`);
    } catch (error) {
      this.logError('Erreur mise à jour statut', { adId, status, error: error.message });
    }
  }

  // Arrêt du service
  public async stop() {
    try {
      // Arrêter tous les intervalles de polling
      for (const interval of this.pollingIntervals.values()) {
        clearInterval(interval);
      }
      
      this.pollingIntervals.clear();
      this.activeAds.clear();
      this.adMetricsCache.clear();
      
      console.log('🛑 Service Stop Loss Hybride arrêté');
    } catch (error) {
      this.logError('Erreur arrêt service', { error: error.message });
    }
  }
}

export default HybridStopLossService;
