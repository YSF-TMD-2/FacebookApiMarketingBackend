import { supabase } from '../supabaseClient.js';

interface RateLimitInfo {
  callCount: number;
  quotaUsagePercent: number;
  resetAt: number;
  lastRequestAt: number;
}

interface BackoffState {
  retryCount: number;
  baseDelay: number;
  maxDelay: number;
  multiplier: number;
}

interface QuotaHeaders {
  callCount: number;
  totalCallTime: number;
  totalCpuTime: number;
  estimatedTimeToReset: number;
}

class RateLimitManager {
  private quotaCache: Map<string, RateLimitInfo> = new Map();
  private backoffStates: Map<string, BackoffState> = new Map();
  private readonly DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 heure
  private readonly MAX_REQUESTS_PER_HOUR = 4800; // Limite Meta par défaut
  private readonly BATCH_MAX_PER_HOUR = 200;

  /**
   * Parser les headers X-Business-Use-Case-Usage de Meta API
   */
  parseQuotaHeaders(headers: Headers): QuotaHeaders | null {
    const usageHeader = headers.get('x-business-use-case-usage');
    if (!usageHeader) return null;

    try {
      const usage = JSON.parse(usageHeader);
      // Format Meta: [{ "call_count": 100, "total_cpu_time": 50, "total_time": 1000, "estimated_time_to_regain_limit": 3600 }]
      const data = Array.isArray(usage) ? usage[0] : usage;
      
      return {
        callCount: data.call_count || 0,
        totalCallTime: data.total_time || 0,
        totalCpuTime: data.total_cpu_time || 0,
        estimatedTimeToReset: data.estimated_time_to_regain_limit || 0
      };
    } catch (error) {
      console.warn('⚠️ Error parsing quota headers:', error);
      return null;
    }
  }

  /**
   * Vérifier si on peut faire une requête sans dépasser le quota
   */
  async canMakeRequest(userId: string, accountId?: string): Promise<boolean> {
    const key = this.getCacheKey(userId, accountId);
    const quota = this.quotaCache.get(key);

    if (!quota) return true; // Pas de données = OK

    const usagePercent = quota.quotaUsagePercent;
    const maxUsage = 95; // Seuil de sécurité à 95%

    if (usagePercent >= maxUsage) {
      console.warn(`⚠️ Quota usage too high for ${key}: ${usagePercent}%`);
      return false;
    }

    return true;
  }

  /**
   * Mettre à jour le quota après une requête
   */
  async updateQuota(
    userId: string, 
    accountId: string | undefined,
    quotaHeaders: QuotaHeaders | null
  ): Promise<void> {
    const key = this.getCacheKey(userId, accountId);
    
    if (!quotaHeaders) {
      // Si pas de headers, incrémenter un compteur simple
      const current = this.quotaCache.get(key) || {
        callCount: 0,
        quotaUsagePercent: 0,
        resetAt: Date.now() + this.DEFAULT_WINDOW_MS,
        lastRequestAt: Date.now()
      };
      
      current.callCount++;
      current.quotaUsagePercent = Math.min(100, (current.callCount / this.MAX_REQUESTS_PER_HOUR) * 100);
      current.lastRequestAt = Date.now();
      
      this.quotaCache.set(key, current);
      
      // Mettre à jour en base de données
      await this.saveQuotaToDB(userId, accountId, current);
      return;
    }

    // Utiliser les données Meta
    const quotaInfo: RateLimitInfo = {
      callCount: quotaHeaders.callCount,
      quotaUsagePercent: Math.min(100, (quotaHeaders.callCount / this.MAX_REQUESTS_PER_HOUR) * 100),
      resetAt: Date.now() + (quotaHeaders.estimatedTimeToReset * 1000),
      lastRequestAt: Date.now()
    };

    this.quotaCache.set(key, quotaInfo);
    await this.saveQuotaToDB(userId, accountId, quotaInfo);
  }

  /**
   * Calculer le délai de backoff exponentiel
   */
  getBackoffDelay(userId: string, accountId?: string): number {
    const key = this.getBackoffKey(userId, accountId);
    const state = this.backoffStates.get(key) || {
      retryCount: 0,
      baseDelay: 1000,
      maxDelay: 300000, // 5 minutes max
      multiplier: 2
    };

    const delay = Math.min(
      state.baseDelay * Math.pow(state.multiplier, state.retryCount),
      state.maxDelay
    );

    return delay;
  }

  /**
   * Incrémenter le compteur de retry pour backoff
   */
  incrementBackoff(userId: string, accountId?: string): void {
    const key = this.getBackoffKey(userId, accountId);
    const state = this.backoffStates.get(key) || {
      retryCount: 0,
      baseDelay: 1000,
      maxDelay: 300000,
      multiplier: 2
    };

    state.retryCount++;
    this.backoffStates.set(key, state);
  }

  /**
   * Réinitialiser le backoff après succès
   */
  resetBackoff(userId: string, accountId?: string): void {
    const key = this.getBackoffKey(userId, accountId);
    this.backoffStates.delete(key);
  }

  /**
   * Calculer le délai à attendre avant la prochaine requête
   */
  async getWaitTime(userId: string, accountId?: string): Promise<number> {
    const key = this.getCacheKey(userId, accountId);
    const quota = this.quotaCache.get(key);

    if (!quota) return 0;

    const usagePercent = quota.quotaUsagePercent;
    
    // Si usage > 80%, attendre proportionnellement
    if (usagePercent > 80) {
      const waitPercent = (usagePercent - 80) / 20; // 0 à 1
      return Math.min(60000, waitPercent * 60000); // Max 1 minute
    }

    // Si proche du reset, attendre un peu
    const timeToReset = quota.resetAt - Date.now();
    if (timeToReset > 0 && timeToReset < 60000) {
      return Math.min(5000, timeToReset / 2);
    }

    return 0;
  }

  /**
   * Obtenir les statistiques de quota pour un utilisateur
   */
  async getQuotaStats(userId: string, accountId?: string): Promise<RateLimitInfo | null> {
    const key = this.getCacheKey(userId, accountId);
    
    // Vérifier en mémoire d'abord
    let quota = this.quotaCache.get(key);
    
    if (!quota) {
      // Charger depuis la base de données
      quota = await this.loadQuotaFromDB(userId, accountId);
      if (quota) {
        this.quotaCache.set(key, quota);
      }
    }

    return quota;
  }

  /**
   * Nettoyer les quotas expirés
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, quota] of this.quotaCache.entries()) {
      if (now > quota.resetAt) {
        this.quotaCache.delete(key);
      }
    }
  }

  // ==================== Méthodes privées ====================

  private getCacheKey(userId: string, accountId?: string): string {
    return accountId ? `${userId}:${accountId}` : userId;
  }

  private getBackoffKey(userId: string, accountId?: string): string {
    return `backoff:${this.getCacheKey(userId, accountId)}`;
  }

  private async saveQuotaToDB(
    userId: string,
    accountId: string | undefined,
    quota: RateLimitInfo
  ): Promise<void> {
    try {
      const { error } = await supabase
        .from('api_quota_tracking')
        .upsert({
          user_id: userId,
          account_id: accountId || null,
          call_count: quota.callCount,
          quota_usage_percent: Math.round(quota.quotaUsagePercent),
          last_reset_at: new Date(quota.resetAt).toISOString(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id,account_id'
        });

      if (error) {
        console.warn('⚠️ Error saving quota to DB:', error);
      }
    } catch (error) {
      console.warn('⚠️ Error saving quota:', error);
    }
  }

  private async loadQuotaFromDB(
    userId: string,
    accountId?: string
  ): Promise<RateLimitInfo | null> {
    try {
      let query = supabase
        .from('api_quota_tracking')
        .select('*')
        .eq('user_id', userId);

      if (accountId) {
        query = query.eq('account_id', accountId);
      } else {
        query = query.is('account_id', null);
      }

      const { data, error } = await query.single();

      if (error || !data) return null;

      return {
        callCount: data.call_count || 0,
        quotaUsagePercent: data.quota_usage_percent || 0,
        resetAt: new Date(data.last_reset_at).getTime(),
        lastRequestAt: new Date(data.updated_at).getTime()
      };
    } catch (error) {
      console.warn('⚠️ Error loading quota from DB:', error);
      return null;
    }
  }
}

// Instance singleton
export const rateLimitManager = new RateLimitManager();

// Nettoyer périodiquement
setInterval(() => {
  rateLimitManager.cleanup();
}, 5 * 60 * 1000); // Toutes les 5 minutes

