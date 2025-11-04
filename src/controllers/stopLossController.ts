import { Request, Response } from "../types/express.js";
import { getFacebookToken, fetchFbGraph } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";
import { StopLossSettingsService } from "../services/stopLossSettingsService.js";

// Configurer le stop loss pour une ad
export async function configureStopLoss(req: Request, res: Response) {
    try {
        console.log('🔍 Stop loss request received');
        console.log('🔍 User:', req.user);
        console.log('🔍 Params:', req.params);
        console.log('🔍 Body:', req.body);
        
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "User not authenticated"
            });
        }

        const userId = req.user.id;
        const { adId } = req.params;
        const { costPerResult, zeroResultsSpend, enabled } = req.body;

        console.log('🔍 Configuring stop loss for ad:', adId, 'CPR:', costPerResult, 'Zero Results Spend:', zeroResultsSpend, 'Enabled:', enabled);
        console.log('🔍 Full request body:', req.body);

        // Récupérer le token Facebook pour obtenir les détails de l'ad
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les détails de l'ad pour logging
        let adDetails = null;
        let accountId = null;
        try {
            const adResponse = await fetchFbGraph(tokenRow.token, `${adId}?fields=id,name,status,adset_id,account_id`);
            adDetails = adResponse;
            accountId = adResponse.account_id;
        } catch (error) {
            console.log('⚠️ Could not fetch ad details:', error);
            return res.status(400).json({
                success: false,
                message: "Could not fetch ad details. Please check if the ad ID is valid."
            });
        }

        // Si enabled est false, désactiver le stop loss (pas besoin de seuils)
        if (enabled === false) {
            const result = await StopLossSettingsService.disableStopLoss(userId, adId);
            if (!result.success) {
                return res.status(500).json({
                    success: false,
                    message: result.error || "Failed to disable stop loss"
                });
            }
            await createLog(userId, "STOP_LOSS_CONFIG", {
                adId,
                adName: adDetails?.name || 'Unknown',
                enabled: false
            });
            return res.json({
                success: true,
                message: "Stop loss disabled successfully"
            });
        }

        // Valider les paramètres (seulement si on active)
        if ((costPerResult === undefined || costPerResult === null) && (zeroResultsSpend === undefined || zeroResultsSpend === null)) {
            return res.status(400).json({
                success: false,
                message: "At least one threshold must be provided: costPerResult or zeroResultsSpend"
            });
        }

        // Utiliser le service pour configurer le stop loss en base de données
        const result = await StopLossSettingsService.enableStopLoss(
            userId,
            adId,
            accountId,
            adDetails?.name,
            {
                costPerResult: costPerResult || null,
                zeroResultsSpend: zeroResultsSpend || null
            },
            enabled !== undefined ? enabled : true
        );

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || "Failed to configure stop loss"
            });
        }

        // Log de création
        await createLog(userId, "STOP_LOSS_CONFIG", {
            adId,
            adName: adDetails?.name || 'Unknown',
            costPerResult,
            zeroResultsSpend,
            enabled
        });

        console.log('Stop loss configuration created successfully for ad:', adId);

        return res.json({
            success: true,
            message: "Stop loss configuration saved successfully",
            data: result.data
        });

    } catch (error: any) {
        console.error('❌ Error configuring stop loss:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// Récupérer les configurations stop loss d'un utilisateur
export async function getStopLossConfigs(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        
        const result = await StopLossSettingsService.getEnabledStopLossAds(userId);
        
        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || "Failed to fetch stop loss configurations"
            });
        }

        return res.json({
            success: true,
            data: result.data || []
        });

    } catch (error: any) {
        console.error('❌ Error fetching stop loss configs:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Récupérer la configuration stop loss d'une ad spécifique
export async function getStopLossConfig(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;

        const result = await StopLossSettingsService.getStopLossStatus(userId, adId);
        
        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || "Failed to fetch stop loss configuration"
            });
        }

        return res.json({
            success: true,
            data: result.data || {
                enabled: false,
                cost_per_result_threshold: 1.50,
                zero_results_spend_threshold: 1.50
            }
        });

    } catch (error: any) {
        console.error('❌ Error fetching stop loss config:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Supprimer une configuration stop loss
export async function deleteStopLossConfig(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;

        const result = await StopLossSettingsService.disableStopLoss(userId, adId);
        
        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || "Failed to delete stop loss configuration"
            });
        }

        await createLog(userId, "STOP_LOSS_DELETED", { adId });

        return res.json({
            success: true,
            message: "Stop loss configuration deleted successfully"
        });

    } catch (error: any) {
        console.error('❌ Error deleting stop loss config:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Surveiller les métriques et exécuter les actions stop loss
export async function monitorStopLoss() {
    try {
        console.log('🔍 Monitoring stop loss conditions...');
        
        // Récupérer toutes les configurations actives depuis la base de données
        const { supabase } = await import('../supabaseClient.js');
        const { data: activeConfigs, error } = await supabase
            .from('stop_loss_settings')
            .select('*')
            .eq('enabled', true);

        if (error) {
            console.error('❌ Error fetching active stop loss configs:', error);
            return;
        }

        if (!activeConfigs || activeConfigs.length === 0) {
            console.log('📊 No active stop loss configurations found');
            return;
        }

        console.log(`📊 Monitoring ${activeConfigs.length} active stop loss configurations`);

        for (const config of activeConfigs) {
            try {
                // Récupérer le token Facebook
                const tokenRow = await getFacebookToken(config.user_id);
                
                // Récupérer les métriques de l'ad pour aujourd'hui
                const insightsResponse = await fetchFbGraph(
                    tokenRow.token, 
                    `${config.ad_id}/insights?fields=spend,actions&date_preset=today`
                );
                
                const insights = insightsResponse.data?.[0];
                if (!insights) continue;

                const spend = parseFloat(insights.spend || 0);
                let results = 0;
                
                // Compter les résultats depuis les actions
                if (insights.actions && Array.isArray(insights.actions)) {
                    results = insights.actions.reduce((total: number, action: any) => {
                        if (action.action_type === 'lead' || action.action_type === 'purchase' || action.action_type === 'conversion') {
                            return total + parseInt(action.value || 0);
                        }
                        return total;
                    }, 0);
                }

                console.log(`🔍 Checking ad ${config.ad_id}: spend=$${spend}, results=${results}`);

                let shouldTrigger = false;
                let triggerReason = '';

                // Vérifier les conditions de stop loss
                if (config.cost_per_result_threshold && results > 0) {
                    const costPerResult = spend / results;
                    if (costPerResult >= config.cost_per_result_threshold) {
                        shouldTrigger = true;
                        triggerReason = `Cost per result ($${costPerResult.toFixed(2)}) exceeded threshold ($${config.cost_per_result_threshold})`;
                    }
                }

                if (config.zero_results_spend_threshold && results === 0 && spend >= config.zero_results_spend_threshold) {
                    shouldTrigger = true;
                    triggerReason = `Zero results spend ($${spend}) exceeded threshold ($${config.zero_results_spend_threshold})`;
                }

                // Si le seuil est atteint, exécuter l'action
                if (shouldTrigger) {
                    console.log(`🚨 Stop loss triggered for ad ${config.ad_id}: ${triggerReason}`);
                    
                    // Mettre en pause l'annonce
                    const response = await fetch(`https://graph.facebook.com/v18.0/${config.ad_id}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            status: 'PAUSED',
                            access_token: tokenRow.token
                        })
                    });

                    if (response.ok) {
                        console.log(`✅ Ad ${config.ad_id} paused due to stop loss`);
                        
                        // Désactiver la configuration après exécution
                        await StopLossSettingsService.disableStopLoss(config.user_id, config.ad_id);
                        
                        // Log de l'exécution
                        await createLog(config.user_id, "STOP_LOSS_TRIGGERED", {
                            adId: config.ad_id,
                            adName: config.ad_name,
                            reason: triggerReason,
                            spend,
                            results,
                            triggeredAt: new Date().toISOString()
                        });
                    } else {
                        console.error(`❌ Failed to pause ad ${config.ad_id}`);
                    }
                }

            } catch (error) {
                console.error(`❌ Error monitoring stop loss for ad ${config.ad_id}:`, error);
            }
        }

    } catch (error) {
        console.error('❌ Error in monitorStopLoss:', error);
    }
}

// Démarrer le service de surveillance stop loss
export function startStopLossService() {
    console.log('🚀 Starting stop loss monitoring service...');
    
    // Surveiller toutes les 5 minutes
    setInterval(monitorStopLoss, 5 * 60 * 1000); // 5 minutes
    
    console.log('✅ Stop loss monitoring service started');
}
