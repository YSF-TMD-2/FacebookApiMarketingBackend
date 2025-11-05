import { supabase } from '../supabaseClient.js';

interface SystemSettings {
  stop_loss_batch?: {
    enabled: boolean;
    batch_interval_ms: number;
    max_parallel_requests: number;
    batch_size: number;
    max_retries: number;
    retry_delay_base_ms: number;
    backoff_multiplier: number;
    quota_threshold_percent: number;
    throttle_enabled: boolean;
  };
  rate_limit?: {
    max_requests_per_hour: number;
    max_batch_requests_per_hour: number;
    window_size_ms: number;
    backoff_enabled: boolean;
  };
}

interface UserBatchConfig {
  user_id: string;
  email?: string | null;
  name?: string | null;
  role?: string;
  batch_interval_ms: number;
  enabled: boolean;
  last_run_at?: string;
  quota_usage_percent: number;
}

export class AdminSystemSettingsService {
  /**
   * Récupérer tous les paramètres système
   */
  static async getSettings(): Promise<{ success: boolean; data?: SystemSettings; error?: string }> {
    try {
      const { data, error } = await supabase
        .from('system_settings')
        .select('key, value');

      if (error) throw error;

      const settings: SystemSettings = {};
      data.forEach(item => {
        settings[item.key as keyof SystemSettings] = item.value;
      });

      return { success: true, data: settings };
    } catch (error) {
      console.error('❌ Error getting system settings:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Mettre à jour les paramètres système
   */
  static async updateSettings(
    key: string,
    value: any
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key,
          value,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'key'
        });

      if (error) throw error;

      return { success: true };
    } catch (error) {
      console.error('❌ Error updating system settings:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Activer/désactiver le batch stop-loss
   */
  static async toggleBatch(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'stop_loss_batch')
        .single();

      if (!data) {
        return { success: false, error: 'stop_loss_batch settings not found' };
      }

      const settings = data.value as any;
      settings.enabled = enabled;

      return await this.updateSettings('stop_loss_batch', settings);
    } catch (error) {
      console.error(' Error toggling batch:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Récupérer les utilisateurs avec leurs configurations batch
   * Récupère TOUS les utilisateurs inscrits, pas seulement ceux avec stop-loss activé
   */
  static async getUsersWithBatchConfig(): Promise<{
    success: boolean;
    data?: UserBatchConfig[];
    error?: string;
  }> {
    try {
      // Récupérer tous les utilisateurs depuis access_tokens (tous les utilisateurs qui se sont connectés)
      const { data: allUsers, error: usersError } = await supabase
        .from('access_tokens')
        .select('userId')
        .order('updated_at', { ascending: false });

      if (usersError) {
        console.warn('⚠️ Error fetching users from access_tokens:', usersError);
        // Continuer avec une liste vide plutôt que de planter
      }

      // Créer un Set pour avoir des user_id uniques
      const uniqueUserIds = new Set<string>();
      allUsers?.forEach(row => {
        if (row.userId) {
          uniqueUserIds.add(row.userId);
        }
      });

      // Récupérer les informations utilisateur (email, nom) depuis auth.users via RPC
      let userInfoMap = new Map<string, { email: string | null; name: string | null; role: string }>();
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_all_users');
        if (!rpcError && rpcData && Array.isArray(rpcData)) {
          rpcData.forEach((user: any) => {
            userInfoMap.set(user.id, {
              email: user.email || null,
              name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || null,
              role: user.role || 'user'
            });
          });
        } else if (rpcError) {
          console.warn(' Error calling get_all_users RPC:', rpcError);
        }
      } catch (rpcError) {
        console.warn(' Error fetching user info from RPC:', rpcError);
      }

      // Récupérer toutes les configs stop-loss pour avoir last_activity
      const { data: stopLossData } = await supabase
        .from('stop_loss_settings')
        .select('user_id, account_id, enabled, updated_at');

      // Grouper par user_id
      const userMap = new Map<string, {
        user_id: string;
        accounts: string[];
        last_activity: string;
      }>();

      // Initialiser tous les utilisateurs
      uniqueUserIds.forEach(userId => {
        userMap.set(userId, {
          user_id: userId,
          accounts: [],
          last_activity: 'Never'
        });
      });

      // Ajouter les infos de last_activity depuis stop_loss_settings
      stopLossData?.forEach(item => {
        const user = userMap.get(item.user_id);
        if (user) {
          if (item.account_id && !user.accounts.includes(item.account_id)) {
            user.accounts.push(item.account_id);
          }
          if (new Date(item.updated_at) > new Date(user.last_activity)) {
            user.last_activity = item.updated_at;
          }
        }
      });

      // Récupérer les quotas pour chaque utilisateur
      const { data: quotaData, error: quotaError } = await supabase
        .from('api_quota_tracking')
        .select('user_id, account_id, quota_usage_percent, updated_at');

      if (quotaError) {
        console.warn(' Error fetching quota data:', quotaError);
      }

      // Calculer le quota max par utilisateur
      const userQuotas = new Map<string, number>();
      quotaData?.forEach(item => {
        const current = userQuotas.get(item.user_id) || 0;
        userQuotas.set(item.user_id, Math.max(current, item.quota_usage_percent || 0));
      });

      // Récupérer les configs batch par utilisateur
      const { data: batchConfigs, error: batchConfigError } = await supabase
        .from('user_batch_config')
        .select('*');

      if (batchConfigError) {
        // Si la table n'existe pas, continuer sans configs personnalisées
        if (batchConfigError.code === 'PGRST205' || batchConfigError.message?.includes('Could not find the table')) {
          console.warn('Table user_batch_config does not exist. Using default configs. Please run: backend/create-user-batch-config-table.sql');
        } else {
          console.warn('Error fetching batch configs:', batchConfigError);
        }
      }

      const batchConfigMap = new Map(
        (batchConfigs || []).map(config => [config.user_id, config])
      );

      // Construire la réponse en enrichissant avec les informations utilisateur
      const result: UserBatchConfig[] = Array.from(userMap.values()).map(user => {
        const batchConfig = batchConfigMap.get(user.user_id);
        const userInfo = userInfoMap.get(user.user_id);
        
        return {
          user_id: user.user_id,
          email: userInfo?.email || null,
          name: userInfo?.name || null,
          role: userInfo?.role || 'user',
          batch_interval_ms: batchConfig?.batch_interval_ms || 60000, // 1 minute par défaut
          enabled: batchConfig?.enabled !== undefined ? batchConfig.enabled : true,
          last_run_at: user.last_activity !== 'Never' ? user.last_activity : undefined,
          quota_usage_percent: userQuotas.get(user.user_id) || 0
        };
      });

      return { success: true, data: result };
    } catch (error) {
      console.error('❌ Error getting users with batch config:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Récupérer les détails d'un utilisateur
   */
  static async getUserDetails(userId: string): Promise<{
    success: boolean;
    data?: any;
    error?: string;
  }> {
    try {
      // Récupérer les informations utilisateur depuis auth.users via RPC
      let userInfo: any = {
        id: userId,
        email: null,
        name: null,
        email_confirmed: false,
        created_at: null,
        updated_at: null,
        last_activity: null
      };

      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_all_users');
        if (!rpcError && rpcData && Array.isArray(rpcData)) {
          const user = rpcData.find((u: any) => u.id === userId);
          if (user) {
            userInfo = {
              id: user.id,
              email: user.email || null,
              name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || null,
              email_confirmed: !!user.email_confirmed_at,
              created_at: user.created_at || null,
              updated_at: user.updated_at || null,
              last_activity: user.last_activity || null
            };
          }
        } else if (rpcError) {
          console.warn('⚠️ Error calling get_all_users RPC:', rpcError);
        }
      } catch (rpcError) {
        console.warn('⚠️ Error fetching user info from RPC:', rpcError);
      }

      // Récupérer le rôle depuis user_roles
      const { data: roleData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .single();

      // Récupérer les infos de token pour avoir last_activity si disponible
      const { data: tokenData } = await supabase
        .from('access_tokens')
        .select('created_at, updated_at')
        .eq('userId', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Récupérer les données stop-loss
      const { data: stopLossData, error: stopLossError } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('enabled', true);

      // Récupérer les quotas
      const { data: quotaData, error: quotaError } = await supabase
        .from('api_quota_tracking')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

      // Récupérer les logs récents
      const { data: logsData, error: logsError } = await supabase
        .from('logs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      // Récupérer les notifications récentes
      const { data: notificationsData, error: notificationsError } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);

      return {
        success: true,
        data: {
          user: userInfo,
          role: (roleData?.role as string) || 'user',
          stop_loss_ads: stopLossData || [],
          quota_tracking: quotaData || [],
          recent_logs: logsData || [],
          recent_notifications: notificationsData || [],
          stats: {
            total_stop_loss_ads: stopLossData?.length || 0,
            total_quota_entries: quotaData?.length || 0,
            max_quota_usage: Math.max(...(quotaData?.map(q => q.quota_usage_percent) || [0])),
            recent_activity: logsData?.length || 0
          }
        }
      };
    } catch (error) {
      console.error('❌ Error getting user details:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Mettre à jour la configuration batch d'un utilisateur spécifique
   */
  static async updateUserBatchConfig(
    userId: string,
    config: { batch_interval_ms?: number; enabled?: boolean; max_parallel_requests?: number }
  ): Promise<{ success: boolean; error?: string; data?: any }> {
    try {
      // Si on essaie d'activer le batch, vérifier qu'il y a au moins un ad avec stop-loss configuré
      if (config.enabled === true) {
        const { data: stopLossAds, error: stopLossError } = await supabase
          .from('stop_loss_settings')
          .select('id')
          .eq('user_id', userId)
          .eq('enabled', true);

        if (stopLossError) {
          console.error('❌ Error checking stop-loss ads:', stopLossError);
          // Ne pas bloquer si erreur de requête, mais logger
        } else if (!stopLossAds || stopLossAds.length === 0) {
          return {
            success: false,
            error: 'Cannot enable batch processing: No stop-loss ads configured for this user. Please configure at least one stop-loss ad first.'
          };
        }
      }

      // Vérifier que batch_interval_ms est au moins 60000ms (1 minute)
      if (config.batch_interval_ms !== undefined && config.batch_interval_ms < 60000) {
        return {
          success: false,
          error: 'Batch interval must be at least 60000ms (1 minute)'
        };
      }

      // Upsert dans user_batch_config
      const updateData: any = {
        user_id: userId,
        updated_at: new Date().toISOString()
      };

      if (config.batch_interval_ms !== undefined) {
        updateData.batch_interval_ms = config.batch_interval_ms;
      }
      if (config.enabled !== undefined) {
        updateData.enabled = config.enabled;
      }
      if (config.max_parallel_requests !== undefined) {
        updateData.max_parallel_requests = config.max_parallel_requests;
      }

      const { data, error } = await supabase
        .from('user_batch_config')
        .upsert(updateData, {
          onConflict: 'user_id'
        })
        .select()
        .single();

      if (error) {
        console.error('❌ Supabase error details:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        
        // Si la table n'existe pas, donner un message d'erreur clair
        if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
          throw new Error(
            'La table user_batch_config n\'existe pas. ' +
            'Veuillez exécuter le script SQL: backend/create-user-batch-config-table.sql dans Supabase SQL Editor.'
          );
        }
        
        throw error;
      }

      // Logger l'action
      await supabase.from('logs').insert({
        user_id: userId,
        action: 'ADMIN_BATCH_CONFIG_UPDATE',
        details: config
      });

      return { success: true, data };
    } catch (error) {
      console.error('❌ Error updating user batch config:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Récupérer la configuration batch d'un utilisateur
   */
  static async getUserBatchConfig(userId: string): Promise<{
    success: boolean;
    data?: {
      user_id: string;
      batch_interval_ms: number;
      enabled: boolean;
      max_parallel_requests: number;
      created_at: string;
      updated_at: string;
    };
    error?: string;
  }> {
    try {
      const { data, error } = await supabase
        .from('user_batch_config')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        // Si la table n'existe pas, retourner les valeurs par défaut
        if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
          console.warn('⚠️ Table user_batch_config does not exist. Using defaults. Please run: backend/create-user-batch-config-table.sql');
          return {
            success: true,
            data: {
              user_id: userId,
              batch_interval_ms: 60000,
              enabled: true,
              max_parallel_requests: 5,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          };
        }
        throw error;
      }

      // Si pas de config, retourner les valeurs par défaut
      if (!data) {
        return {
          success: true,
          data: {
            user_id: userId,
            batch_interval_ms: 60000, // 1 minute par défaut
            enabled: true,
            max_parallel_requests: 5,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        };
      }

      return { success: true, data };
    } catch (error) {
      console.error('❌ Error getting user batch config:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

export default AdminSystemSettingsService;

