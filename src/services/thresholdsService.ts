import { supabase } from '../supabaseClient.js';
import { createLog } from './loggerService.js';

export interface ThresholdsConfig {
  costPerResultThreshold: number;
  zeroResultsSpendThreshold: number;
}

const DEFAULT_THRESHOLDS: ThresholdsConfig = {
  costPerResultThreshold: 1.50,
  zeroResultsSpendThreshold: 1.50
};

export class ThresholdsService {
  // Récupérer les thresholds d'un utilisateur
  static async getUserThresholds(userId: string): Promise<ThresholdsConfig> {
    try {
      const { data, error } = await supabase
        .from('thresholds')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // Aucun threshold trouvé, retourner les valeurs par défaut
          console.log('🔧 No thresholds found for user, using defaults');
          return DEFAULT_THRESHOLDS;
        }
        throw error;
      }

      console.log('✅ Thresholds retrieved for user:', userId);
      return {
        costPerResultThreshold: data.cost_per_result_threshold,
        zeroResultsSpendThreshold: data.zero_results_spend_threshold
      };
    } catch (error) {
      console.error('❌ Error getting user thresholds:', error);
      return DEFAULT_THRESHOLDS;
    }
  }

  // Sauvegarder ou mettre à jour les thresholds d'un utilisateur
  static async saveUserThresholds(userId: string, config: ThresholdsConfig): Promise<boolean> {
    try {
      // Vérifier si des thresholds existent déjà
      const { data: existing } = await supabase
        .from('thresholds')
        .select('id')
        .eq('user_id', userId)
        .single();

      const now = new Date().toISOString();

      if (existing) {
        // Mettre à jour les thresholds existants
        const { error } = await supabase
          .from('thresholds')
          .update({
            cost_per_result_threshold: config.costPerResultThreshold,
            zero_results_spend_threshold: config.zeroResultsSpendThreshold,
            updated_at: now
          })
          .eq('user_id', userId);

        if (error) throw error;

        console.log('✅ Thresholds updated for user:', userId);
      } else {
        // Créer de nouveaux thresholds
        const { error } = await supabase
          .from('thresholds')
          .insert({
            user_id: userId,
            cost_per_result_threshold: config.costPerResultThreshold,
            zero_results_spend_threshold: config.zeroResultsSpendThreshold,
            created_at: now,
            updated_at: now
          });

        if (error) throw error;

        console.log('✅ Thresholds created for user:', userId);
      }

      // Logger l'action
      await createLog(userId, 'THRESHOLDS_UPDATED', {
        costPerResultThreshold: config.costPerResultThreshold,
        zeroResultsSpendThreshold: config.zeroResultsSpendThreshold
      });

      return true;
    } catch (error) {
      console.error('❌ Error saving user thresholds:', error);
      return false;
    }
  }

  // Réinitialiser les thresholds aux valeurs par défaut
  static async resetUserThresholds(userId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('thresholds')
        .delete()
        .eq('user_id', userId);

      if (error) throw error;

      console.log('✅ Thresholds reset for user:', userId);

      // Logger l'action
      await createLog(userId, 'THRESHOLDS_RESET', {
        message: 'Thresholds reset to default values'
      });

      return true;
    } catch (error) {
      console.error('❌ Error resetting user thresholds:', error);
      return false;
    }
  }

  // Vérifier si un ad doit être arrêté basé sur les thresholds
  static async shouldStopAd(
    userId: string, 
    adSpend: number, 
    results: number
  ): Promise<{ shouldStop: boolean; reason?: string; threshold?: number }> {
    try {
      const thresholds = await this.getUserThresholds(userId);

      // Cas 1: Il y a des résultats - vérifier le cost per result
      if (results > 0) {
        const costPerResult = adSpend / results;
        if (costPerResult >= thresholds.costPerResultThreshold) {
          return {
            shouldStop: true,
            reason: `Cost per result ($${costPerResult.toFixed(2)}) exceeds threshold ($${thresholds.costPerResultThreshold})`,
            threshold: thresholds.costPerResultThreshold
          };
        }
      }
      // Cas 2: Aucun résultat - vérifier le spend
      else if (results === 0) {
        if (adSpend >= thresholds.zeroResultsSpendThreshold) {
          return {
            shouldStop: true,
            reason: `Ad spend ($${adSpend.toFixed(2)}) exceeds zero results threshold ($${thresholds.zeroResultsSpendThreshold})`,
            threshold: thresholds.zeroResultsSpendThreshold
          };
        }
      }

      return { shouldStop: false };
    } catch (error) {
      console.error('❌ Error checking stop conditions:', error);
      return { shouldStop: false };
    }
  }
}
