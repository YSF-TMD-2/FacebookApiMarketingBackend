import { Request, Response } from "../types/express.js";
import { getFacebookToken, fetchFbGraph } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";

// Interface pour les configurations de stop loss
interface StopLossConfig {
    adId: string;
    condition: 'spend' | 'cpc' | 'cpl' | 'cpa';
    threshold: number;
    action: 'pause' | 'delete';
    enabled: boolean;
    createdAt: Date;
    userId: string;
}

// Stockage temporaire des configurations stop loss (en production, utiliser une base de données)
const stopLossConfigs: Map<string, StopLossConfig[]> = new Map();

// Configurer le stop loss pour une ad
export async function configureStopLoss(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { condition, threshold, action } = req.body;

        console.log('🔍 Configuring stop loss for ad:', adId, 'Condition:', condition, 'Threshold:', threshold);

        // Valider les paramètres
        if (!condition || threshold === undefined || !action) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters: condition, threshold, action"
            });
        }

        if (!['spend', 'cpc', 'cpl', 'cpa'].includes(condition)) {
            return res.status(400).json({
                success: false,
                message: "Invalid condition. Must be one of: spend, cpc, cpl, cpa"
            });
        }

        if (!['pause', 'delete'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: "Invalid action. Must be one of: pause, delete"
            });
        }

        // Récupérer le token Facebook
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les détails de l'ad pour logging
        let adDetails = null;
        try {
            const adResponse = await fetchFbGraph(tokenRow.token, `${adId}?fields=id,name,status,adset_id`);
            adDetails = adResponse;
        } catch (error) {
            console.log('⚠️ Could not fetch ad details:', error);
        }

        // Créer la configuration stop loss
        const stopLossConfig: StopLossConfig = {
            adId,
            condition,
            threshold,
            action,
            enabled: true,
            createdAt: new Date(),
            userId
        };

        // Stocker la configuration (en production, sauvegarder en base de données)
        if (!stopLossConfigs.has(userId)) {
            stopLossConfigs.set(userId, []);
        }

        // Supprimer l'ancienne configuration pour cette ad si elle existe
        const userConfigs = stopLossConfigs.get(userId)!;
        const filteredConfigs = userConfigs.filter(config => config.adId !== adId);
        
        // Ajouter la nouvelle configuration
        filteredConfigs.push(stopLossConfig);
        stopLossConfigs.set(userId, filteredConfigs);

        // Log de création
        await createLog(userId, "STOP_LOSS_CONFIG", {
            adId,
            adName: adDetails?.name || 'Unknown',
            condition,
            threshold,
            action
        });

        console.log('✅ Stop loss configuration created successfully for ad:', adId);

        return res.json({
            success: true,
            message: "Stop loss configuration saved successfully",
            data: {
                adId,
                condition,
                threshold,
                action,
                enabled: true
            }
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
        const userConfigs = stopLossConfigs.get(userId) || [];

        return res.json({
            success: true,
            data: userConfigs
        });

    } catch (error: any) {
        console.error('❌ Error fetching stop loss configs:', error);
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

        const userConfigs = stopLossConfigs.get(userId) || [];
        const filteredConfigs = userConfigs.filter(config => config.adId !== adId);

        stopLossConfigs.set(userId, filteredConfigs);

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
        // Vérifier s'il y a des configurations actives
        let hasActiveConfigs = false;
        for (const [userId, userConfigs] of stopLossConfigs.entries()) {
            if (userConfigs.some(config => config.enabled)) {
                hasActiveConfigs = true;
                break;
            }
        }
        
        // Ne logger que s'il y a des configurations actives
        if (hasActiveConfigs) {
            console.log('🔍 Monitoring stop loss conditions...');
        }
        
        for (const [userId, userConfigs] of stopLossConfigs.entries()) {
            for (const config of userConfigs) {
                if (!config.enabled) continue;

                try {
                    // Récupérer le token Facebook
                    const tokenRow = await getFacebookToken(userId);
                    
                    // Récupérer les métriques de l'ad pour les dernières 24h
                    const insightsResponse = await fetchFbGraph(
                        tokenRow.token, 
                        `${config.adId}/insights?fields=spend,impressions,clicks,conversions,cpc&date_preset=yesterday`
                    );
                    
                    const insights = insightsResponse.data?.[0];
                    if (!insights) continue;

                    let currentValue = 0;
                    let shouldTrigger = false;

                    // Calculer la valeur actuelle selon la condition
                    switch (config.condition) {
                        case 'spend':
                            currentValue = parseFloat(insights.spend || 0);
                            shouldTrigger = currentValue >= config.threshold;
                            break;
                        case 'cpc':
                            currentValue = parseFloat(insights.cpc || 0);
                            shouldTrigger = currentValue >= config.threshold;
                            break;
                        case 'cpl':
                            const clicks = parseInt(insights.clicks || 0);
                            const conversions = parseInt(insights.conversions || 0);
                            currentValue = clicks > 0 ? parseFloat(insights.spend || 0) / conversions : 0;
                            shouldTrigger = currentValue >= config.threshold;
                            break;
                        case 'cpa':
                            const conversionsForCpa = parseInt(insights.conversions || 0);
                            currentValue = conversionsForCpa > 0 ? parseFloat(insights.spend || 0) / conversionsForCpa : 0;
                            shouldTrigger = currentValue >= config.threshold;
                            break;
                    }

                    // Si le seuil est atteint, exécuter l'action
                    if (shouldTrigger) {
                        console.log(`🚨 Stop loss triggered for ad ${config.adId}: ${config.condition} = ${currentValue} >= ${config.threshold}`);
                        
                        let newStatus = 'PAUSED';
                        if (config.action === 'delete') {
                            newStatus = 'DELETED';
                        }

                        // Appeler l'API Facebook pour changer le statut
                        const response = await fetch(`https://graph.facebook.com/v18.0/${config.adId}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                status: newStatus,
                                access_token: tokenRow.token
                            })
                        });

                        if (response.ok) {
                            console.log(`✅ Stop loss action executed for ad ${config.adId}: ${config.action}`);
                            
                            // Log de l'exécution
                            await createLog(userId, "STOP_LOSS_TRIGGERED", {
                                adId: config.adId,
                                condition: config.condition,
                                threshold: config.threshold,
                                currentValue,
                                action: config.action,
                                newStatus,
                                triggeredAt: new Date().toISOString()
                            });

                            // Désactiver la configuration après exécution
                            config.enabled = false;
                        } else {
                            console.error(`❌ Failed to execute stop loss action for ad ${config.adId}`);
                        }
                    }

                } catch (error) {
                    console.error(`❌ Error monitoring stop loss for ad ${config.adId}:`, error);
                }
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
