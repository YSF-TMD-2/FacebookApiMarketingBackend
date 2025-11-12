import { Request, Response } from "../types/express.js";
import { StopLossSettingsService } from "../services/stopLossSettingsService.js";
import { supabase } from "../supabaseClient.js";
import { createLog } from "../services/loggerService.js";

/**
 * Récupérer tous les stop-loss de l'utilisateur connecté (actifs et désactivés)
 */
export async function getMyStopLoss(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated"
      });
    }

    const userId = req.user.id;

    // Récupérer tous les stop-loss de l'utilisateur (pas seulement enabled)
    const { data, error } = await supabase
      .from('stop_loss_settings')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('❌ Error fetching stop-loss:', error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch stop-loss settings"
      });
    }

    // Calculer les statistiques
    const stats = {
      total: data?.length || 0,
      active: data?.filter(item => item.enabled === true).length || 0,
      disabled: data?.filter(item => item.enabled === false).length || 0
    };

    return res.json({
      success: true,
      data: data || [],
      stats
    });

  } catch (error: any) {
    console.error('❌ Error in getMyStopLoss:', error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error"
    });
  }
}

/**
 * Récupérer les détails d'un stop-loss spécifique de l'utilisateur
 */
export async function getMyStopLossDetails(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated"
      });
    }

    const userId = req.user.id;
    const { adId } = req.params;

    // Vérifier que le stop-loss appartient à l'utilisateur
    const { data, error } = await supabase
      .from('stop_loss_settings')
      .select('*')
      .eq('user_id', userId)
      .eq('ad_id', adId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        message: "Stop-loss not found or access denied"
      });
    }

    // Récupérer les logs récents pour ce stop-loss
    const { data: logs } = await supabase
      .from('logs')
      .select('*')
      .eq('user_id', userId)
      .eq('details->>adId', adId)
      .or('action.eq.STOP_LOSS_CONFIG,action.eq.STOP_LOSS_TRIGGERED')
      .order('created_at', { ascending: false })
      .limit(10);

    return res.json({
      success: true,
      data: {
        ...data,
        recent_logs: logs || []
      }
    });

  } catch (error: any) {
    console.error('❌ Error in getMyStopLossDetails:', error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error"
    });
  }
}

/**
 * Enable/Disable un stop-loss de l'utilisateur
 */
export async function toggleMyStopLoss(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated"
      });
    }

    const userId = req.user.id;
    const { adId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: "enabled must be a boolean"
      });
    }

    // Vérifier que le stop-loss existe et appartient à l'utilisateur
    // Récupérer la configuration la plus récente (active ou inactive) pour cette ad
    const { data: existingConfigs, error: checkError } = await supabase
      .from('stop_loss_settings')
      .select('*')
      .eq('user_id', userId)
      .eq('ad_id', adId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (checkError) {
      console.error('❌ Error checking stop-loss:', checkError);
      return res.status(500).json({
        success: false,
        message: "Failed to check stop-loss configuration"
      });
    }

    const existing = existingConfigs && existingConfigs.length > 0 ? existingConfigs[0] : null;

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Stop-loss not found or access denied"
      });
    }

    // Mettre à jour l'entrée existante (la contrainte unique empêche d'en créer une nouvelle)
    const { data, error } = await supabase
      .from('stop_loss_settings')
      .update({
        enabled: enabled,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating stop-loss:', error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to update stop-loss"
      });
    }

    // Logger l'action
    await createLog(userId, "STOP_LOSS_CONFIG", {
      adId,
      adName: existing.ad_name || 'Unknown',
      enabled: enabled,
      action: enabled ? 'enabled' : 'disabled'
    });

    // Redémarrer le service batch si nécessaire (si le stop-loss est activé)
    if (enabled) {
      const { optimizedStopLossService } = await import("../services/optimizedStopLossService.js");
      optimizedStopLossService.restartIfNeeded().catch(err => {
        console.error('⚠️ Error restarting stop-loss service:', err);
      });
    }

    return res.json({
      success: true,
      message: `Stop-loss ${enabled ? 'enabled' : 'disabled'} successfully`,
      data
    });

  } catch (error: any) {
    console.error('❌ Error in toggleMyStopLoss:', error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error"
    });
  }
}

/**
 * Mettre à jour les seuils d'un stop-loss de l'utilisateur
 */
export async function updateMyStopLossThresholds(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated"
      });
    }

    const userId = req.user.id;
    const { adId } = req.params;
    const { costPerResult, zeroResultsSpend } = req.body;

    // Validation : au moins un seuil doit être fourni
    if ((costPerResult === undefined || costPerResult === null) && 
        (zeroResultsSpend === undefined || zeroResultsSpend === null)) {
      return res.status(400).json({
        success: false,
        message: "At least one threshold must be provided: costPerResult or zeroResultsSpend"
      });
    }

    // Vérifier que le stop-loss existe et appartient à l'utilisateur
    const { data: existing, error: checkError } = await supabase
      .from('stop_loss_settings')
      .select('*')
      .eq('user_id', userId)
      .eq('ad_id', adId)
      .single();

    if (checkError || !existing) {
      return res.status(404).json({
        success: false,
        message: "Stop-loss not found or access denied"
      });
    }

    // Utiliser le service pour mettre à jour les seuils
    const result = await StopLossSettingsService.updateThresholds(userId, adId, {
      costPerResult: costPerResult !== undefined ? costPerResult : null,
      zeroResultsSpend: zeroResultsSpend !== undefined ? zeroResultsSpend : null
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || "Failed to update thresholds"
      });
    }

    // Logger l'action
    await createLog(userId, "STOP_LOSS_CONFIG", {
      adId,
      adName: existing.ad_name || 'Unknown',
      costPerResult,
      zeroResultsSpend,
      action: 'thresholds_updated'
    });

    return res.json({
      success: true,
      message: "Stop-loss thresholds updated successfully",
      data: result.data
    });

  } catch (error: any) {
    console.error('❌ Error in updateMyStopLossThresholds:', error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error"
    });
  }
}

/**
 * Supprimer un stop-loss de l'utilisateur
 */
export async function deleteMyStopLoss(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated"
      });
    }

    const userId = req.user.id;
    const { adId } = req.params;

    // Vérifier que le stop-loss existe et appartient à l'utilisateur
    const { data: existing, error: checkError } = await supabase
      .from('stop_loss_settings')
      .select('*')
      .eq('user_id', userId)
      .eq('ad_id', adId)
      .single();

    if (checkError || !existing) {
      return res.status(404).json({
        success: false,
        message: "Stop-loss not found or access denied"
      });
    }

    // Utiliser le service pour supprimer le stop-loss
    const result = await StopLossSettingsService.disableStopLoss(userId, adId);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || "Failed to delete stop-loss"
      });
    }

    // Logger l'action
    await createLog(userId, "STOP_LOSS_CONFIG", {
      adId,
      adName: existing.ad_name || 'Unknown',
      action: 'deleted'
    });

    return res.json({
      success: true,
      message: "Stop-loss deleted successfully"
    });

  } catch (error: any) {
    console.error('❌ Error in deleteMyStopLoss:', error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error"
    });
  }
}

