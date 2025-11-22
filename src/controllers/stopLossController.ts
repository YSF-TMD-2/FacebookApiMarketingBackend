import { Request, Response } from "../types/express.js";
import { getFacebookToken, fetchFbGraph } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";
import { StopLossSettingsService } from "../services/stopLossSettingsService.js";
import { optimizedStopLossService } from "../services/optimizedStopLossService.js";

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
        const { costPerResult, zeroResultsSpend, enabled, cprEnabled, zeroResultsEnabled } = req.body;

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
        // Vérifier qu'au moins un seuil est activé ET configuré
        const hasCPR = cprEnabled && costPerResult !== undefined && costPerResult !== null && costPerResult > 0;
        const hasZeroResults = zeroResultsEnabled && zeroResultsSpend !== undefined && zeroResultsSpend !== null && zeroResultsSpend > 0;
        
        if (enabled !== false && !hasCPR && !hasZeroResults) {
            return res.status(400).json({
                success: false,
                message: "At least one threshold must be enabled and configured with a value greater than 0. Please enable and configure at least one threshold (Cost Per Result or Zero Results Spend) before activating stop-loss."
            });
        }
        
        // Validation supplémentaire : Si un seuil est activé, il doit avoir une valeur > 0
        if (cprEnabled && (costPerResult === undefined || costPerResult === null || costPerResult <= 0)) {
            return res.status(400).json({
                success: false,
                message: "Cost Per Result threshold is enabled but no valid value is provided. Please set a value greater than 0 or disable this threshold."
            });
        }
        
        if (zeroResultsEnabled && (zeroResultsSpend === undefined || zeroResultsSpend === null || zeroResultsSpend <= 0)) {
            return res.status(400).json({
                success: false,
                message: "Zero Results Spend threshold is enabled but no valid value is provided. Please set a value greater than 0 or disable this threshold."
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
                zeroResultsSpend: zeroResultsSpend || null,
                cprEnabled: cprEnabled !== undefined ? cprEnabled : (costPerResult ? true : null),
                zeroResultsEnabled: zeroResultsEnabled !== undefined ? zeroResultsEnabled : (zeroResultsSpend ? true : null)
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

        // Redémarrer le service batch si nécessaire (si le stop-loss est activé)
        if (enabled !== false && result.data?.enabled) {
          optimizedStopLossService.restartIfNeeded().catch(err => {
            console.error('⚠️ Error restarting stop-loss service:', err);
          });
        }

        console.log('Stop loss configuration created successfully for ad:', adId);

        return res.json({
            success: true,
            message: "Stop loss configuration saved successfully",
            data: result.data
        });

    } catch (error: any) {
        console.error('❌ Error configuring stop loss:', error);
        console.error('❌ Error stack:', error.stack);
        console.error('❌ Error details:', JSON.stringify(error, null, 2));
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null,
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
                // Priorité: utiliser conversions/conversion_values de Facebook (plus fiable)
                // Sinon, compter uniquement les types exacts 'lead', 'purchase', 'conversion' (pas les variations)
                if (insights.conversions || insights.conversion_values) {
                    results = parseFloat(insights.conversions || insights.conversion_values || 0);
                } else if (insights.actions && Array.isArray(insights.actions)) {
                    results = insights.actions.reduce((total: number, action: any) => {
                        // Utiliser uniquement les types exacts pour éviter les doublons
                        if (action.action_type === 'lead' || action.action_type === 'purchase' || action.action_type === 'conversion') {
                            return total + parseInt(action.value || 0);
                        }
                        return total;
                    }, 0);
                }

                // S'assurer que les seuils sont bien des nombres
                const costPerResultThreshold = config.cost_per_result_threshold ? parseFloat(String(config.cost_per_result_threshold)) : null;
                const zeroResultsSpendThreshold = config.zero_results_spend_threshold ? parseFloat(String(config.zero_results_spend_threshold)) : null;

                console.log(`🔍 Checking ad ${config.ad_id}: spend=$${spend.toFixed(2)}, results=${results}`);
                console.log(`🔍 Stop loss config: cost_per_result_threshold=${costPerResultThreshold}, zero_results_spend_threshold=${zeroResultsSpendThreshold}`);
                console.log(`🔍 Config types: cost_per_result_threshold type=${typeof costPerResultThreshold}, zero_results_spend_threshold type=${typeof zeroResultsSpendThreshold}`);
                console.log(`🔍 Spend type: ${typeof spend}, value: ${spend}`);

                let shouldTrigger = false;
                let triggerReason = '';

                // Vérifier les conditions de stop loss
                // 1. Vérifier le cost per result si il y a des résultats
                if (costPerResultThreshold && results > 0) {
                    const costPerResult = spend / results;
                    console.log(`🔍 Cost per result: $${costPerResult.toFixed(2)} vs threshold: $${costPerResultThreshold}`);
                    console.log(`🔍 Comparison: ${costPerResult} >= ${costPerResultThreshold} = ${costPerResult >= costPerResultThreshold}`);
                    if (costPerResult >= costPerResultThreshold) {
                        shouldTrigger = true;
                        triggerReason = `Cost per result ($${costPerResult.toFixed(2)}) exceeded threshold ($${costPerResultThreshold})`;
                    }
                }
                // 2. Vérifier le zero results spend si il n'y a pas de résultats
                else if (zeroResultsSpendThreshold !== null && results === 0) {
                    console.log(`🔍 Zero results spend: $${spend.toFixed(2)} vs threshold: $${zeroResultsSpendThreshold}`);
                    console.log(`🔍 Comparison: ${spend} >= ${zeroResultsSpendThreshold} = ${spend >= zeroResultsSpendThreshold}`);
                    if (spend >= zeroResultsSpendThreshold) {
                        shouldTrigger = true;
                        triggerReason = `Zero results spend ($${spend.toFixed(2)}) exceeded threshold ($${zeroResultsSpendThreshold})`;
                    }
                } else {
                    console.log(`⚠️ No stop loss condition checked: results=${results}, costPerResultThreshold=${costPerResultThreshold}, zeroResultsSpendThreshold=${zeroResultsSpendThreshold}`);
                }

                // Si le seuil est atteint, exécuter l'action
                if (shouldTrigger) {
                    console.log(`🚨 Stop loss triggered for ad ${config.ad_id}: ${triggerReason}`);
                    
                    // Mettre en pause l'annonce
                    // Facebook Graph API nécessite le token dans l'URL, pas dans le body
                    const response = await fetch(`https://graph.facebook.com/v18.0/${config.ad_id}?access_token=${tokenRow.token}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            status: 'PAUSED'
                        })
                    });

                    if (response.ok) {
                        console.log(`✅ Ad ${config.ad_id} paused due to stop loss`);
                        
                        // Désactiver la configuration après exécution
                        await StopLossSettingsService.disableStopLoss(config.user_id, config.ad_id);
                        
                        // Créer une notification pour l'utilisateur
                        try {
                            const { error: notifError } = await supabase.from('notifications').insert({
                                user_id: config.user_id,
                                type: 'stop_loss',
                                title: '🛑 Stop Loss Déclenché',
                                message: `La publicité "${config.ad_name || config.ad_id}" a été arrêtée automatiquement.`,
                                data: {
                                    ad_id: config.ad_id,
                                    ad_name: config.ad_name || config.ad_id,
                                    spend: spend,
                                    results: results,
                                    reason: triggerReason,
                                    triggered_at: new Date().toISOString(),
                                    threshold: zeroResultsSpendThreshold || costPerResultThreshold,
                                    actual_value: results > 0 ? (spend / results) : spend
                                },
                                is_read: false
                            });

                            if (notifError) {
                                console.error(`❌ Error creating notification for ad ${config.ad_id}:`, notifError);
                                console.error(`❌ Error details:`, JSON.stringify(notifError, null, 2));
                            } else {
                                console.log(`✅ Notification created successfully for ad ${config.ad_id}`);
                                console.log(`🔔 Notification details:`, {
                                    user_id: config.user_id,
                                    type: 'stop_loss',
                                    ad_id: config.ad_id,
                                    ad_name: config.ad_name
                                });
                            }
                        } catch (notifErr) {
                            console.warn(`⚠️ Error creating notification for ad ${config.ad_id}:`, notifErr);
                        }
                        
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

// Vérifier manuellement le stop loss pour une ad spécifique (appelé depuis l'API)
export async function checkStopLossManually(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;

        console.log(`🔍 Manual stop loss check requested for ad ${adId} by user ${userId}`);

        // Récupérer le token Facebook
        const tokenRow = await getFacebookToken(userId);
        
        // Récupérer les métriques de l'ad pour aujourd'hui
        const insightsResponse = await fetchFbGraph(
            tokenRow.token, 
            `${adId}/insights?fields=spend,actions,conversions,conversion_values&date_preset=today`
        );
        
        const insights = insightsResponse.data?.[0];
        if (!insights) {
            return res.status(404).json({
                success: false,
                message: "No insights data found for this ad today"
            });
        }

        const spend = parseFloat(insights.spend || 0);
        let results = 0;
        
        // Compter les résultats depuis les actions
        // Priorité: utiliser conversions/conversion_values de Facebook (plus fiable)
        // Sinon, compter uniquement les types exacts 'lead', 'purchase', 'conversion' (pas les variations)
        if (insights.conversions || insights.conversion_values) {
            results = parseFloat(insights.conversions || insights.conversion_values || 0);
            console.log(`🔍 [Manual Check] Using conversions field: ${results}`);
        } else if (insights.actions && Array.isArray(insights.actions)) {
            console.log(`🔍 [Manual Check] Actions array found:`, JSON.stringify(insights.actions, null, 2));
            // Compter uniquement les types exacts pour éviter les doublons
            results = insights.actions.reduce((total: number, action: any) => {
                const actionType = action.action_type || '';
                const actionValue = parseInt(action.value || 0);
                // Utiliser uniquement les types exacts, pas les variations (pour éviter les doublons)
                const isResult = actionType === 'lead' || actionType === 'purchase' || actionType === 'conversion';
                if (isResult && actionValue > 0) {
                    console.log(`✅ [Manual Check] Found result action: type=${actionType}, value=${actionValue}`);
                    return total + actionValue;
                }
                return total;
            }, 0);
            console.log(`🔍 [Manual Check] Total results from actions (exact types only): ${results}`);
        } else {
            console.log(`⚠️ [Manual Check] No conversions or actions data available`);
            results = 0;
        }

        console.log(`🔍 [Manual Check] Final metrics - Ad ${adId}: spend=$${spend.toFixed(2)}, results=${results}`);

        // Récupérer la configuration stop loss
        const { supabase } = await import('../supabaseClient.js');
        const { data: stopLossConfig } = await supabase
            .from('stop_loss_settings')
            .select('*')
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .eq('enabled', true)
            .single();

        if (!stopLossConfig) {
            return res.json({
                success: true,
                shouldStop: false,
                message: "Stop-loss is not enabled for this ad",
                metrics: { spend, results }
            });
        }

        // S'assurer que les seuils sont bien des nombres
        const costPerResultThreshold = stopLossConfig.cost_per_result_threshold ? parseFloat(String(stopLossConfig.cost_per_result_threshold)) : null;
        const zeroResultsSpendThreshold = stopLossConfig.zero_results_spend_threshold ? parseFloat(String(stopLossConfig.zero_results_spend_threshold)) : null;
        
        // Vérifier quels seuils sont activés (par défaut true si null pour rétrocompatibilité)
        const cprEnabled = stopLossConfig.cpr_enabled !== null ? stopLossConfig.cpr_enabled : true;
        const zeroResultsEnabled = stopLossConfig.zero_results_enabled !== null ? stopLossConfig.zero_results_enabled : true;

        console.log(`🔍 [Manual Check] Ad ${adId}: spend=$${spend.toFixed(2)}, results=${results}`);
        console.log(`🔍 [Manual Check] Thresholds: costPerResult=${costPerResultThreshold}, zeroResultsSpend=${zeroResultsSpendThreshold}`);
        console.log(`🔍 [Manual Check] Thresholds enabled: cpr_enabled=${cprEnabled}, zero_results_enabled=${zeroResultsEnabled}`);
        console.log(`🔍 [Manual Check] Types: spend=${typeof spend}, costPerResultThreshold=${typeof costPerResultThreshold}, zeroResultsSpendThreshold=${typeof zeroResultsSpendThreshold}`);

        let shouldTrigger = false;
        let triggerReason = '';

        // Vérifier les conditions de stop loss
        // 1. Vérifier le cost per result si il y a des résultats ET que le seuil est configuré ET activé
        if (results > 0 && costPerResultThreshold !== null && costPerResultThreshold > 0 && cprEnabled) {
            const costPerResult = spend / results;
            console.log(`🔍 [Manual Check] Cost per result: $${costPerResult.toFixed(2)} vs threshold: $${costPerResultThreshold}`);
            console.log(`🔍 [Manual Check] Comparison: ${costPerResult} >= ${costPerResultThreshold} = ${costPerResult >= costPerResultThreshold}`);
            if (costPerResult >= costPerResultThreshold) {
                shouldTrigger = true;
                triggerReason = `Cost per result ($${costPerResult.toFixed(2)}) exceeded threshold ($${costPerResultThreshold})`;
            }
        }
        // 2. Vérifier le zero results spend si il n'y a pas de résultats ET que le seuil est configuré ET activé
        if (results === 0 && zeroResultsSpendThreshold !== null && zeroResultsSpendThreshold > 0 && zeroResultsEnabled) {
            console.log(`🔍 [Manual Check] Zero results spend: $${spend.toFixed(2)} vs threshold: $${zeroResultsSpendThreshold}`);
            console.log(`🔍 [Manual Check] Comparison: ${spend} >= ${zeroResultsSpendThreshold} = ${spend >= zeroResultsSpendThreshold}`);
            if (spend >= zeroResultsSpendThreshold) {
                shouldTrigger = true;
                triggerReason = `Zero results spend ($${spend.toFixed(2)}) exceeded threshold ($${zeroResultsSpendThreshold})`;
                console.log(`✅ [Manual Check] Zero results spend condition MET!`);
            } else {
                console.log(`⚠️ [Manual Check] Zero results spend condition NOT met: spend ($${spend.toFixed(2)}) < threshold ($${zeroResultsSpendThreshold})`);
            }
        }
        
        // Si aucune condition n'a été vérifiée, logger pourquoi
        if (!shouldTrigger) {
            let debugReason = '';
            if (results === 0) {
                if (!zeroResultsEnabled) {
                    debugReason = `Zero results spend threshold is disabled`;
                } else if (!zeroResultsSpendThreshold || zeroResultsSpendThreshold <= 0) {
                    debugReason = `Zero results spend threshold not configured (threshold: ${zeroResultsSpendThreshold})`;
                } else if (spend < zeroResultsSpendThreshold) {
                    debugReason = `Spend ($${spend.toFixed(2)}) is below zero results threshold ($${zeroResultsSpendThreshold})`;
                } else {
                    debugReason = `Zero results but condition not met: spend=$${spend.toFixed(2)}, threshold=$${zeroResultsSpendThreshold}`;
                }
            } else {
                if (!cprEnabled) {
                    debugReason = `Cost per result threshold is disabled`;
                } else if (!costPerResultThreshold || costPerResultThreshold <= 0) {
                    debugReason = `Cost per result threshold not configured (threshold: ${costPerResultThreshold})`;
                } else {
                    const costPerResult = spend / results;
                    if (costPerResult < costPerResultThreshold) {
                        debugReason = `CPR ($${costPerResult.toFixed(2)}) is below threshold ($${costPerResultThreshold})`;
                    } else {
                        debugReason = `Has results (${results}) but CPR condition not met: CPR=$${costPerResult.toFixed(2)}, threshold=$${costPerResultThreshold}`;
                    }
                }
            }
            console.log(`⚠️ [Manual Check] Stop-loss conditions not met: ${debugReason}`);
        }

        // Si le seuil est atteint, exécuter l'action
        if (shouldTrigger) {
            console.log(`🚨 Manual stop loss triggered for ad ${adId}: ${triggerReason}`);
            
            // Mettre en pause l'annonce
            // Facebook Graph API nécessite le token dans l'URL, pas dans le body
            const response = await fetch(`https://graph.facebook.com/v18.0/${adId}?access_token=${tokenRow.token}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    status: 'PAUSED'
                })
            });

            if (response.ok) {
                console.log(`✅ Ad ${adId} paused successfully due to manual stop loss check`);
                
                // Désactiver la configuration après exécution
                await StopLossSettingsService.disableStopLoss(userId, adId);
                
                // Créer une notification
                try {
                    const { error: notifError } = await supabase.from('notifications').insert({
                        user_id: userId,
                        type: 'stop_loss',
                        title: '🛑 Stop Loss Déclenché',
                        message: `La publicité "${stopLossConfig.ad_name || adId}" a été arrêtée automatiquement.`,
                        data: {
                            ad_id: adId,
                            ad_name: stopLossConfig.ad_name || adId,
                            spend: spend,
                            results: results,
                            reason: triggerReason,
                            triggered_at: new Date().toISOString(),
                            threshold: zeroResultsSpendThreshold || costPerResultThreshold,
                            actual_value: results > 0 ? (spend / results) : spend
                        },
                        is_read: false
                    });

                    if (notifError) {
                        console.error(`❌ Error creating notification for ad ${adId}:`, notifError);
                        console.error(`❌ Error details:`, JSON.stringify(notifError, null, 2));
                    } else {
                        console.log(`✅ Notification created successfully for ad ${adId}`);
                        console.log(`🔔 Notification details:`, {
                            user_id: userId,
                            type: 'stop_loss',
                            ad_id: adId,
                            ad_name: stopLossConfig.ad_name
                        });
                    }
                } catch (notifErr) {
                    console.warn(`⚠️ Error creating notification:`, notifErr);
                }
                
                // Logger l'action
                await createLog(userId, "STOP_LOSS_TRIGGERED", {
                    adId,
                    adName: stopLossConfig.ad_name,
                    reason: triggerReason,
                    spend,
                    results,
                    triggeredAt: new Date().toISOString(),
                    triggeredBy: 'manual_check'
                });

                return res.json({
                    success: true,
                    shouldStop: true,
                    paused: true,
                    message: "Ad paused successfully",
                    reason: triggerReason,
                    metrics: { spend, results }
                });
            } else {
                const errorData = await response.json();
                console.error(`❌ Failed to pause ad ${adId}:`, errorData);
                return res.status(500).json({
                    success: false,
                    shouldStop: true,
                    paused: false,
                    message: "Stop-loss condition met but failed to pause ad",
                    error: errorData,
                    reason: triggerReason
                });
            }
        }

               // Construire le message de debug détaillé
               let debugReason = '';
               if (shouldTrigger) {
                   debugReason = triggerReason;
               } else {
                   if (results === 0) {
                       if (!zeroResultsEnabled) {
                           debugReason = `Zero results spend threshold is disabled`;
                       } else if (!zeroResultsSpendThreshold || zeroResultsSpendThreshold <= 0) {
                           debugReason = `Zero results spend threshold not configured`;
                       } else if (spend < zeroResultsSpendThreshold) {
                           debugReason = `Spend ($${spend.toFixed(2)}) is below zero results threshold ($${zeroResultsSpendThreshold})`;
                       } else {
                           debugReason = `Zero results but condition not met`;
                       }
                   } else {
                       if (!cprEnabled) {
                           debugReason = `Cost per result threshold is disabled`;
                       } else if (!costPerResultThreshold || costPerResultThreshold <= 0) {
                           debugReason = `Cost per result threshold not configured`;
                       } else {
                           const costPerResult = spend / results;
                           if (costPerResult < costPerResultThreshold) {
                               debugReason = `CPR ($${costPerResult.toFixed(2)}) is below threshold ($${costPerResultThreshold})`;
                           } else {
                               debugReason = `CPR condition not met: CPR=$${costPerResult.toFixed(2)}, threshold=$${costPerResultThreshold}`;
                           }
                       }
                   }
               }

               // Retourner des informations détaillées pour le débogage
               const response = {
                   success: true,
                   shouldStop: shouldTrigger,
                   paused: false,
                   message: shouldTrigger ? "Stop-loss condition met but action not executed" : "Stop-loss conditions not met",
                   metrics: { spend, results },
                   thresholds: {
                       costPerResult: costPerResultThreshold,
                       zeroResultsSpend: zeroResultsSpendThreshold,
                       cprEnabled,
                       zeroResultsEnabled
                   },
                   debug: {
                       spend,
                       results,
                       costPerResultThreshold,
                       zeroResultsSpendThreshold,
                       cprEnabled,
                       zeroResultsEnabled,
                       costPerResult: results > 0 ? spend / results : null,
                       reason: debugReason
                   }
               };
        
        console.log(`📊 [Manual Check] Final response:`, JSON.stringify(response, null, 2));
        
        return res.json(response);

    } catch (error: any) {
        console.error('❌ Error in manual stop loss check:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Démarrer le service de surveillance stop loss
export function startStopLossService() {
    console.log('🚀 Starting stop loss monitoring service...');
    
    // Surveiller toutes les 5 minutes
    setInterval(monitorStopLoss, 5 * 60 * 1000); // 5 minutes
    
    console.log('✅ Stop loss monitoring service started');
}
