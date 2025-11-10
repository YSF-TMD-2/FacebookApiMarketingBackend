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

      // Vérifier si l'annonce existe déjà
      const { data: existing, error: fetchError } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        throw fetchError;
      }

      if (existing) {
        // Mettre à jour l'enregistrement existant
        // Construire l'objet de mise à jour de manière conditionnelle pour éviter les erreurs si les colonnes n'existent pas
        const updateData: any = {
          enabled: enabled,
          ad_name: adName,
          cost_per_result_threshold: thresholds?.costPerResult || null,
          zero_results_spend_threshold: thresholds?.zeroResultsSpend || null,
          updated_at: new Date().toISOString()
        };

        // Ajouter les nouveaux champs seulement s'ils sont définis (pour éviter les erreurs si les colonnes n'existent pas encore)
        if (thresholds?.cprEnabled !== undefined) {
          updateData.cpr_enabled = thresholds.cprEnabled;
        } else if (existing.cpr_enabled !== undefined && existing.cpr_enabled !== null) {
          updateData.cpr_enabled = existing.cpr_enabled;
        } else {
          // Par défaut true si pas défini
          updateData.cpr_enabled = true;
        }

        if (thresholds?.zeroResultsEnabled !== undefined) {
          updateData.zero_results_enabled = thresholds.zeroResultsEnabled;
        } else if (existing.zero_results_enabled !== undefined && existing.zero_results_enabled !== null) {
          updateData.zero_results_enabled = existing.zero_results_enabled;
        } else {
          // Par défaut true si pas défini
          updateData.zero_results_enabled = true;
        }

        console.log('🔧 Updating stop loss with data:', updateData);

        const { data, error } = await supabase
          .from('stop_loss_settings')
          .update(updateData)
          .eq('id', existing.id)
          .select()
          .single();

        if (error) {
          console.error('❌ Error updating stop loss:', error);
          // Si l'erreur est due à des colonnes manquantes, essayer sans ces colonnes
          if (error.message && (error.message.includes('column') || error.message.includes('does not exist'))) {
            console.warn('⚠️ Columns cpr_enabled or zero_results_enabled may not exist, trying without them');
            const fallbackData: any = {
              enabled: enabled,
              ad_name: adName,
              cost_per_result_threshold: thresholds?.costPerResult || null,
              zero_results_spend_threshold: thresholds?.zeroResultsSpend || null,
              updated_at: new Date().toISOString()
            };
            const { data: fallbackResult, error: fallbackError } = await supabase
              .from('stop_loss_settings')
              .update(fallbackData)
              .eq('id', existing.id)
              .select()
              .single();
            if (fallbackError) throw fallbackError;
            return { success: true, data: fallbackResult };
          }
          throw error;
        }

        console.log(`✅ Stop loss updated for ad ${adId}`);
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
   */
  static async disableStopLoss(
    userId: string,
    adId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`🔧 Disabling stop loss for ad ${adId} (user: ${userId})`);

      const { error } = await supabase
        .from('stop_loss_settings')
        .delete()
        .eq('user_id', userId)
        .eq('ad_id', adId);

      if (error) throw error;

      console.log(`✅ Stop loss disabled for ad ${adId}`);
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
   * Obtenir l'état du stop loss pour une annonce
   */
  static async getStopLossStatus(
    userId: string,
    adId: string
  ): Promise<{ success: boolean; enabled: boolean; data?: StopLossSettings; error?: string }> {
    try {
      const { data, error } = await supabase
        .from('stop_loss_settings')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return { 
        success: true, 
        enabled: !!data?.enabled,
        data: data || undefined
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
      const updateData: any = {
        updated_at: new Date().toISOString()
      };
      
      if (thresholds.costPerResult !== undefined) {
        updateData.cost_per_result_threshold = thresholds.costPerResult || null;
      }
      if (thresholds.zeroResultsSpend !== undefined) {
        updateData.zero_results_spend_threshold = thresholds.zeroResultsSpend || null;
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
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .select()
        .single();

      if (error) throw error;

      return { success: true, data };
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
