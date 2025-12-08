import { supabase } from '../supabaseClient.js';

export interface StopLossSettings {
  id?: number;
  user_id: string;
  ad_id: string;
  account_id: string;
  ad_name?: string | null;
  enabled: boolean;
  cost_per_result_threshold?: number | null;
  zero_results_spend_threshold?: number | null;
  cpr_enabled?: boolean | null;
  zero_results_enabled?: boolean | null;
  created_at?: string;
  updated_at?: string;
}

export class StopLossSettingsService {
  /**
   * Activer le stop loss pour une annonce
   */
  static async enableStopLoss(
    userId: string,
    adId: string,
    accountId: string,
    adName?: string,
    thresholds?: {
      costPerResult?: number;
      zeroResultsSpend?: number;
      cprEnabled?: boolean;
      zeroResultsEnabled?: boolean;
    },
    enabled: boolean = true
  ): Promise<{ success: boolean; data?: StopLossSettings; error?: string }> {
    try {
      console.log(`🔧 Enabling stop loss for ad ${adId} (user: ${userId})`);

      // Vérifier si l'annonce existe déjà (la contrainte unique empêche plusieurs entrées)
      const { data: existing, error: fetchError } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .maybeSingle();

      if (fetchError && fetchError.code !== 'PGRST116') {
        throw fetchError;
      }

      if (existing) {
        // Mettre à jour l'entrée existante (la contrainte unique empêche d'en créer une nouvelle)
        const updateData: any = {
          account_id: accountId,
          ad_name: adName || existing.ad_name,
          enabled: enabled,
          updated_at: new Date().toISOString()
        };

        // Mettre à jour les seuils seulement s'ils sont fournis
        if (thresholds?.costPerResult !== undefined) {
          updateData.cost_per_result_threshold = thresholds.costPerResult;
        }
        if (thresholds?.zeroResultsSpend !== undefined) {
          updateData.zero_results_spend_threshold = thresholds.zeroResultsSpend;
        }

        // Mettre à jour les flags d'activation
        if (thresholds?.cprEnabled !== undefined) {
          updateData.cpr_enabled = thresholds.cprEnabled;
        }
        if (thresholds?.zeroResultsEnabled !== undefined) {
          updateData.zero_results_enabled = thresholds.zeroResultsEnabled;
        }

        console.log(`📝 Updating existing stop-loss entry for ad ${adId}`);

        const { data, error } = await supabase
          .from('stop_loss_settings')
          .update(updateData)
          .eq('id', existing.id)
          .select()
          .single();

        if (error) {
          console.error('❌ Error updating stop loss entry:', error);
          throw error;
        }

        console.log(`✅ Stop-loss entry updated for ad ${adId}`);
        return { success: true, data };
      } else {
        // Créer un nouvel enregistrement
        const insertData: any = {
          user_id: userId,
          ad_id: adId,
          account_id: accountId,
          ad_name: adName,
          enabled: enabled,
          cost_per_result_threshold: thresholds?.costPerResult || null,
          zero_results_spend_threshold: thresholds?.zeroResultsSpend || null
        };

        // Ajouter les nouveaux champs seulement s'ils sont définis (pour éviter les erreurs si les colonnes n'existent pas encore)
        if (thresholds?.cprEnabled !== undefined) {
          insertData.cpr_enabled = thresholds.cprEnabled;
        } else {
          insertData.cpr_enabled = thresholds?.costPerResult ? true : true; // Par défaut true
        }

        if (thresholds?.zeroResultsEnabled !== undefined) {
          insertData.zero_results_enabled = thresholds.zeroResultsEnabled;
        } else {
          insertData.zero_results_enabled = thresholds?.zeroResultsSpend ? true : true; // Par défaut true
        }

        console.log('🔧 Creating stop loss with data:', insertData);

        const { data, error } = await supabase
          .from('stop_loss_settings')
          .insert(insertData)
          .select()
          .single();

        if (error) {
          console.error('❌ Error creating stop loss:', error);
          
          // Si l'erreur est due à la contrainte unique, mettre à jour l'entrée existante
          if (error.code === '23505' || (error.message && error.message.includes('duplicate key'))) {
            console.log('⚠️ Duplicate key detected, updating existing entry instead');
            const { data: existingEntry } = await supabase
              .from('stop_loss_settings')
              .select('*')
              .eq('user_id', userId)
              .eq('ad_id', adId)
              .maybeSingle();
            
            if (existingEntry) {
              const updateData: any = {
                account_id: accountId,
                ad_name: adName || existingEntry.ad_name,
                enabled: enabled,
                updated_at: new Date().toISOString()
              };

              if (thresholds?.costPerResult !== undefined) {
                updateData.cost_per_result_threshold = thresholds.costPerResult;
              }
              if (thresholds?.zeroResultsSpend !== undefined) {
                updateData.zero_results_spend_threshold = thresholds.zeroResultsSpend;
              }
              if (thresholds?.cprEnabled !== undefined) {
                updateData.cpr_enabled = thresholds.cprEnabled;
              }
              if (thresholds?.zeroResultsEnabled !== undefined) {
                updateData.zero_results_enabled = thresholds.zeroResultsEnabled;
              }

              const { data: updatedData, error: updateError } = await supabase
                .from('stop_loss_settings')
                .update(updateData)
                .eq('id', existingEntry.id)
                .select()
                .single();

              if (updateError) throw updateError;
              return { success: true, data: updatedData };
            }
          }
          
          // Si l'erreur est due à des colonnes manquantes, essayer sans ces colonnes
          if (error.message && (error.message.includes('column') || error.message.includes('does not exist'))) {
            console.warn('⚠️ Columns cpr_enabled or zero_results_enabled may not exist, trying without them');
            const fallbackData: any = {
              user_id: userId,
              ad_id: adId,
              account_id: accountId,
              ad_name: adName,
              enabled: enabled,
              cost_per_result_threshold: thresholds?.costPerResult || null,
              zero_results_spend_threshold: thresholds?.zeroResultsSpend || null
            };
            const { data: fallbackResult, error: fallbackError } = await supabase
              .from('stop_loss_settings')
              .insert(fallbackData)
              .select()
              .single();
            if (fallbackError) throw fallbackError;
            return { success: true, data: fallbackResult };
          }
          throw error;
        }

        console.log(`✅ Stop loss enabled for ad ${adId}`);
        return { success: true, data };
      }
    } catch (error) {
      console.error('❌ Error enabling stop loss:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Désactiver le stop loss pour une annonce
   * IMPORTANT: Archive les configurations (enabled: false) au lieu de les supprimer
   * pour garder l'historique complet même quand l'ad est désactivée
   */
  static async disableStopLoss(
    userId: string,
    adId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`🔧 Disabling stop loss for ad ${adId} (user: ${userId})`);

      // IMPORTANT: Au lieu de supprimer, on archive toutes les configurations actives
      // en les marquant comme enabled: false pour garder l'historique
      const { error } = await supabase
        .from('stop_loss_settings')
        .update({ 
          enabled: false, 
          updated_at: new Date().toISOString() 
        })
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .eq('enabled', true); // Seulement les configurations actives

      if (error) throw error;

      console.log(`✅ Stop loss archived (disabled) for ad ${adId} - history preserved`);
      return { success: true };
    } catch (error) {
      console.error('❌ Error disabling stop loss:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Supprimer définitivement un stop loss pour une annonce
   * Supprime réellement l'enregistrement de la base de données
   */
  static async deleteStopLoss(
    userId: string,
    adId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`🗑️ Deleting stop loss for ad ${adId} (user: ${userId})`);

      // Supprimer toutes les configurations pour cet ad_id et cet utilisateur
      const { error } = await supabase
        .from('stop_loss_settings')
        .delete()
        .eq('user_id', userId)
        .eq('ad_id', adId);

      if (error) throw error;

      console.log(`✅ Stop loss deleted for ad ${adId}`);
      return { success: true };
    } catch (error) {
      console.error('❌ Error deleting stop loss:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Obtenir l'état du stop loss pour une annonce
   * Retourne la configuration active la plus récente, ou la plus récente si aucune n'est active
   */
  static async getStopLossStatus(
    userId: string,
    adId: string
  ): Promise<{ success: boolean; enabled: boolean; data?: StopLossSettings; error?: string }> {
    try {
      // D'abord chercher une configuration active
      const { data: activeConfig, error: activeError } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .eq('enabled', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeError && activeError.code !== 'PGRST116') {
        throw activeError;
      }

      // Si on a une configuration active, la retourner
      if (activeConfig) {
        return { 
          success: true, 
          enabled: true,
          data: activeConfig
        };
      }

      // Sinon, chercher la configuration la plus récente (même inactive)
      const { data: latestConfig, error: latestError } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestError && latestError.code !== 'PGRST116') {
        throw latestError;
      }

      return { 
        success: true, 
        enabled: !!latestConfig?.enabled,
        data: latestConfig || undefined
      };
    } catch (error) {
      console.error('❌ Error getting stop loss status:', error);
      return { 
        success: false, 
        enabled: false,
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Obtenir toutes les annonces avec stop loss activé pour un utilisateur
   */
  static async getEnabledStopLossAds(
    userId: string
  ): Promise<{ success: boolean; data?: StopLossSettings[]; error?: string }> {
    try {
      const { data, error } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('enabled', true)
        .order('updated_at', { ascending: false });

      if (error) throw error;

      return { success: true, data: data || [] };
    } catch (error) {
      console.error('❌ Error getting enabled stop loss ads:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Mettre à jour les seuils pour une annonce
   * IMPORTANT: Crée une nouvelle entrée pour garder l'historique complet
   */
  static async updateThresholds(
    userId: string,
    adId: string,
    thresholds: {
      costPerResult?: number;
      zeroResultsSpend?: number;
      cprEnabled?: boolean;
      zeroResultsEnabled?: boolean;
    }
  ): Promise<{ success: boolean; data?: StopLossSettings; error?: string }> {
    try {
      // Récupérer la configuration existante (la contrainte unique garantit qu'il n'y en a qu'une)
      const { data: existing, error: fetchError } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .maybeSingle();

      if (fetchError && fetchError.code !== 'PGRST116') {
        throw fetchError;
      }

      if (existing) {
        // Mettre à jour l'entrée existante (la contrainte unique empêche d'en créer une nouvelle)
        const updateData: any = {
          updated_at: new Date().toISOString()
        };

        if (thresholds.costPerResult !== undefined) {
          updateData.cost_per_result_threshold = thresholds.costPerResult;
        }
        if (thresholds.zeroResultsSpend !== undefined) {
          updateData.zero_results_spend_threshold = thresholds.zeroResultsSpend;
        }
        if (thresholds.cprEnabled !== undefined) {
          updateData.cpr_enabled = thresholds.cprEnabled;
        }
        if (thresholds.zeroResultsEnabled !== undefined) {
          updateData.zero_results_enabled = thresholds.zeroResultsEnabled;
        }

        const { data, error } = await supabase
          .from('stop_loss_settings')
          .update(updateData)
          .eq('id', existing.id)
          .select()
          .single();

        if (error) throw error;

        console.log(`✅ Threshold configuration updated for ad ${adId}`);
        return { success: true, data };
      } else {
        // Pas de configuration existante, créer une nouvelle
        return { 
          success: false, 
          error: 'No existing stop-loss configuration found to update' 
        };
      }
    } catch (error) {
      console.error('❌ Error updating thresholds:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }
}

export default StopLossSettingsService;
