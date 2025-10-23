import { Request, Response } from "../types/express.js";
import { getFacebookToken, fetchFbGraph } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";
import { supabase } from "../supabaseClient.js";

// Interface pour les données de schedule
interface ScheduleData {
    adId: string;
    scheduleType: 'START' | 'STOP' | 'PAUSE';
    scheduledDate: string;
    timezone: string;
    startMinutes?: number;
    endMinutes?: number;
    executedAt?: string; // Date de dernière exécution
    lastAction?: string; // Dernière action exécutée
}

// Stockage temporaire des schedules (en production, utiliser une base de données)
const schedules: Map<string, ScheduleData[]> = new Map();

// Fonction pour vérifier si un schedule doit être exécuté
function checkIfScheduleShouldExecute(schedule: ScheduleData, now: Date): boolean {
    const scheduledTime = new Date(schedule.scheduledDate);
    
    console.log(`🔍 Checking schedule for ad ${schedule.adId}:`, {
        scheduleType: schedule.scheduleType,
        startMinutes: schedule.startMinutes,
        endMinutes: schedule.endMinutes,
        executedAt: schedule.executedAt,
        lastAction: schedule.lastAction,
        currentTime: now.toISOString()
    });
    
    // Vérifier si c'est un schedule avec plage horaire
    if (schedule.startMinutes !== undefined && schedule.endMinutes !== undefined) {
        const today = new Date();
        const currentMinutes = today.getHours() * 60 + today.getMinutes();
        
        console.log(`🕐 Time check for ad ${schedule.adId}:`, {
            currentMinutes,
            startMinutes: schedule.startMinutes,
            endMinutes: schedule.endMinutes,
            executedAt: schedule.executedAt,
            lastAction: schedule.lastAction
        });
        
        // Si c'est la première exécution (heure de début)
        if (!schedule.executedAt && currentMinutes >= schedule.startMinutes && currentMinutes < schedule.endMinutes) {
            console.log(`🕐 Time to START ad ${schedule.adId} (current: ${currentMinutes}, start: ${schedule.startMinutes})`);
            return true;
        }
        
        // Si c'est l'heure de fin
        if (schedule.executedAt && schedule.lastAction === 'START' && currentMinutes >= schedule.endMinutes) {
            console.log(`🕐 Time to STOP ad ${schedule.adId} (current: ${currentMinutes}, end: ${schedule.endMinutes})`);
            return true;
        }
        
        console.log(`⏰ No action needed for ad ${schedule.adId} at ${currentMinutes} minutes`);
        return false;
    }
    
    // Schedule ponctuel - exécuter si la date/heure est atteinte
    const shouldExecute = now >= scheduledTime;
    console.log(`🕐 Schedule check for ad ${schedule.adId}: now=${now.toISOString()}, scheduled=${scheduledTime.toISOString()}, shouldExecute=${shouldExecute}`);
    return shouldExecute;
}

// Créer un schedule pour une ad
export async function createSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { scheduleType, scheduledDate, timezone, startMinutes, endMinutes } = req.body;

        console.log('🔍 Creating schedule for ad:', adId, 'Type:', scheduleType);
        console.log('🔍 Request body:', req.body);
        console.log('🔍 User ID:', userId);
        console.log('🔍 Start minutes:', startMinutes, 'End minutes:', endMinutes);

        // Valider l'ID de l'ad
        if (!adId || adId.length < 5) {
            return res.status(400).json({
                success: false,
                message: "Invalid ad ID"
            });
        }

        // Valider les paramètres
        if (!scheduleType || !scheduledDate || !timezone) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters: scheduleType, scheduledDate, timezone"
            });
        }
        
        // Valider les minutes si elles sont fournies
        if (startMinutes !== undefined && (startMinutes < 0 || startMinutes > 1439)) {
            return res.status(400).json({
                success: false,
                message: "Invalid start_minutes. Must be between 0 and 1439."
            });
        }
        
        if (endMinutes !== undefined && (endMinutes < 0 || endMinutes > 1439)) {
            return res.status(400).json({
                success: false,
                message: "Invalid end_minutes. Must be between 0 and 1439."
            });
        }
        
        if (startMinutes !== undefined && endMinutes !== undefined && startMinutes >= endMinutes) {
            return res.status(400).json({
                success: false,
                message: "Start time must be before end time."
            });
        }

        // Récupérer le token Facebook
        const tokenRow = await getFacebookToken(userId);
        console.log('🔍 Token retrieved:', tokenRow ? 'Yes' : 'No');
        
        if (!tokenRow || !tokenRow.token) {
            console.error('❌ No Facebook token found for user:', userId);
            return res.status(400).json({
                success: false,
                message: "No Facebook token found. Please reconnect your Facebook account."
            });
        }
        
        // Vérifier si le token est valide
        try {
            const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenRow.token}`);
            if (!testResponse.ok) {
                const testError = await testResponse.json();
                if (testError.error?.code === 190) {
                    console.error('❌ Facebook token expired for user:', userId);
                    return res.status(401).json({
                        success: false,
                        message: "Facebook token expired. Please reconnect your Facebook account."
                    });
                }
            }
        } catch (testError) {
            console.error('❌ Error testing Facebook token:', testError);
            return res.status(500).json({
                success: false,
                message: "Error validating Facebook token."
            });
        }

        // Récupérer les détails de l'ad pour logging
        let adDetails = null;
        try {
            console.log('🔍 Fetching ad details from Facebook API...');
            const fbResponse = await fetch(`https://graph.facebook.com/v18.0/${adId}?fields=id,name,status,adset_id&access_token=${tokenRow.token}`);
            
            if (!fbResponse.ok) {
                console.error('❌ Facebook API error:', fbResponse.status, fbResponse.statusText);
                const errorData = await fbResponse.json();
                console.error('❌ Facebook API error details:', errorData);
                // Continue without ad details
            } else {
            adDetails = await fbResponse.json();
                console.log('✅ Ad details fetched:', adDetails);
            }
        } catch (error) {
            console.log('⚠️ Could not fetch ad details:', error);
            // Continue without ad details
        }

        // Créer l'objet schedule
        const scheduleData: ScheduleData = {
            adId,
            scheduleType,
            scheduledDate,
            timezone,
            startMinutes,
            endMinutes
        };

        // Stocker le schedule en mémoire
        if (!schedules.has(userId)) {
            schedules.set(userId, []);
        }
        schedules.get(userId)!.push(scheduleData);
        console.log('✅ Schedule stored in memory');

        // Log de création avec informations détaillées
        try {
            const logDetails = {
                adId,
                adName: adDetails?.name || 'Unknown',
                scheduleType,
                scheduledDate,
                timezone,
                startMinutes: startMinutes || null,
                endMinutes: endMinutes || null,
                scheduleConfig: {
                    type: scheduleType,
                    startTime: startMinutes ? `${Math.floor(startMinutes / 60)}:${(startMinutes % 60).toString().padStart(2, '0')}` : null,
                    endTime: endMinutes ? `${Math.floor(endMinutes / 60)}:${(endMinutes % 60).toString().padStart(2, '0')}` : null,
                    timezone: timezone
                },
                action: 'SCHEDULE_CREATED',
                timestamp: new Date().toISOString()
            };

            await createLog(userId, "SCHEDULE_CREATE", logDetails);
            console.log('✅ Schedule creation logged successfully:', logDetails);
        } catch (error) {
            console.error('⚠️ Error creating schedule log:', error);
            // Continue even if logging fails
        }

        console.log('✅ Schedule created successfully for ad:', adId);
        
        // Afficher les heures de manière claire
        if (startMinutes !== undefined && endMinutes !== undefined) {
            const startTime = `${Math.floor(startMinutes / 60)}:${startMinutes % 60}`;
            const endTime = `${Math.floor(endMinutes / 60)}:${endMinutes % 60}`;
            console.log('📅 Schedule time range:', {
                startTime,
                endTime,
                startMinutes,
                endMinutes
            });
        }

        return res.json({
            success: true,
            message: "Schedule created successfully",
            data: {
                scheduleId: `${adId}_${Date.now()}`,
                adId,
                scheduleType,
                scheduledDate,
                timezone,
                startMinutes,
                endMinutes,
                startTime: startMinutes !== undefined ? `${Math.floor(startMinutes / 60)}:${startMinutes % 60}` : null,
                endTime: endMinutes !== undefined ? `${Math.floor(endMinutes / 60)}:${endMinutes % 60}` : null
            }
        });

    } catch (error: any) {
        console.error('❌ Error creating schedule:', error);
        console.error('❌ Error details:', {
            message: error.message,
            stack: error.stack,
            response: error.response?.data
        });
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}



// Exécuter les schedules (à appeler périodiquement)
export async function executeSchedules() {
    try {
        console.log('🕐 Executing scheduled tasks...');
        console.log('🕐 Current time:', new Date().toISOString());
        
        const now = new Date();
        let totalSchedules = 0;
        let executedSchedules = 0;
        
        for (const [userId, userSchedules] of schedules.entries()) {
            console.log(`🔍 Checking ${userSchedules.length} schedules for user ${userId}`);
            totalSchedules += userSchedules.length;
            
            for (const schedule of userSchedules) {
                const scheduledTime = new Date(schedule.scheduledDate);
                console.log(`🔍 Schedule for ad ${schedule.adId}: scheduled at ${scheduledTime.toISOString()}, current time: ${now.toISOString()}`);
                
                // Vérifier si le schedule doit être exécuté maintenant
                const shouldExecute = checkIfScheduleShouldExecute(schedule, now);
                if (shouldExecute) {
                    console.log('⚡ Executing schedule for ad:', schedule.adId, 'Type:', schedule.scheduleType);
                    
                    try {
                        // Récupérer le token Facebook
                        const tokenRow = await getFacebookToken(userId);
                        
                        // Vérifier si le token est valide en testant une requête simple
                        try {
                            const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenRow.token}`);
                            if (!testResponse.ok) {
                                const testError = await testResponse.json();
                                if (testError.error?.code === 190) {
                                    console.error('❌ Token expired for user:', userId, 'Skipping schedule execution');
                                    
                                    // Log de l'erreur de token expiré
                                    try {
                                        const tokenErrorLogDetails = {
                                            adId: schedule.adId,
                                            scheduleType: schedule.scheduleType,
                                            error: testError,
                                            executionTime: now.toISOString(),
                                            timezone: schedule.timezone,
                                            action: 'SCHEDULE_TOKEN_EXPIRED',
                                            timestamp: now.toISOString()
                                        };

                                        await createLog(userId, "SCHEDULE_TOKEN_EXPIRED", tokenErrorLogDetails);
                                        console.log('✅ Schedule token expiration logged successfully:', tokenErrorLogDetails);
                                    } catch (logError) {
                                        console.error('⚠️ Error logging schedule token expiration:', logError);
                                    }
                                    
                                    continue; // Passer au schedule suivant
                                }
                            }
                        } catch (testError) {
                            console.error('❌ Error testing token for user:', userId, testError);
                            continue; // Passer au schedule suivant
                        }
                        
                        // Exécuter l'action selon le type et la logique de plage horaire
                        let newStatus = 'ACTIVE';
                        let actionDescription = 'activate';
                        let actionType = schedule.scheduleType;
                        
                        // Pour les plages horaires, déterminer l'action selon l'heure actuelle
                        if (schedule.startMinutes !== undefined && schedule.endMinutes !== undefined) {
                            const today = new Date();
                            const currentMinutes = today.getHours() * 60 + today.getMinutes();
                            
                            if (!schedule.executedAt) {
                                // Première exécution - démarrer l'ad
                                newStatus = 'ACTIVE';
                                actionDescription = 'start (time range)';
                                actionType = 'START';
                            } else if (schedule.lastAction === 'START' && currentMinutes >= schedule.endMinutes) {
                                // Heure de fin - arrêter l'ad
                                newStatus = 'PAUSED';
                                actionDescription = 'stop (time range)';
                                actionType = 'STOP';
                            }
                        } else {
                            // Schedule ponctuel
                            if (schedule.scheduleType === 'START') {
                                newStatus = 'ACTIVE';
                                actionDescription = 'activate';
                            } else if (schedule.scheduleType === 'STOP') {
                                newStatus = 'PAUSED';
                                actionDescription = 'stop';
                            } else if (schedule.scheduleType === 'PAUSE') {
                            newStatus = 'PAUSED';
                                actionDescription = 'pause';
                            }
                        }
                        
                        console.log(`🔄 ${actionDescription} ad ${schedule.adId} to status: ${newStatus}`);
                        
                        // Appeler l'API Facebook pour changer le statut
                        const response = await fetch(`https://graph.facebook.com/v18.0/${schedule.adId}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                status: newStatus,
                                access_token: tokenRow.token
                            })
                        });
                        
                        // Vérifier si le token est expiré
                        if (!response.ok) {
                            const errorData = await response.json();
                            console.error('❌ Facebook API error:', errorData);
                            
                            // Log de l'erreur d'exécution
                            try {
                                const errorLogDetails = {
                                    adId: schedule.adId,
                                    scheduleType: schedule.scheduleType,
                                    actionType: actionType,
                                    error: errorData,
                                    executionTime: now.toISOString(),
                                    timezone: schedule.timezone,
                                    facebookApiResponse: {
                                        status: response.status,
                                        success: false,
                                        error: errorData
                                    },
                                    action: 'SCHEDULE_EXECUTION_FAILED',
                                    timestamp: now.toISOString()
                                };

                                await createLog(userId, "SCHEDULE_EXECUTE_ERROR", errorLogDetails);
                                console.log('✅ Schedule execution error logged successfully:', errorLogDetails);
                            } catch (logError) {
                                console.error('⚠️ Error logging schedule execution error:', logError);
                            }
                            
                            if (errorData.error?.code === 190) {
                                console.error('❌ Token expired for user:', userId);
                                // Marquer le token comme expiré ou supprimer le schedule
                                continue; // Passer au schedule suivant
                            }
                        }
                        
                        if (response.ok) {
                            console.log('✅ Schedule executed successfully for ad:', schedule.adId);
                            executedSchedules++;
                            
                            // Log de l'exécution avec informations détaillées
                            try {
                                const executionLogDetails = {
                                    adId: schedule.adId,
                                    scheduleType: schedule.scheduleType,
                                    actionType: actionType,
                                    newStatus: newStatus,
                                    actionDescription: actionDescription,
                                    executionTime: now.toISOString(),
                                    timezone: schedule.timezone,
                                    originalSchedule: {
                                        startMinutes: schedule.startMinutes,
                                        endMinutes: schedule.endMinutes,
                                        scheduledDate: schedule.scheduledDate
                                    },
                                    facebookApiResponse: {
                                        status: response.status,
                                        success: response.ok
                                    },
                                    action: 'SCHEDULE_EXECUTED',
                                    timestamp: now.toISOString()
                                };

                                await createLog(userId, "SCHEDULE_EXECUTE", executionLogDetails);
                                console.log('✅ Schedule execution logged successfully:', executionLogDetails);
                            } catch (logError) {
                                console.error('⚠️ Error logging schedule execution:', logError);
                            }
                            
                            // Pour les schedules avec plages horaires, ne pas supprimer le schedule
                            // Il sera réutilisé pour l'heure de fin
                            if (schedule.startMinutes !== undefined && schedule.endMinutes !== undefined) {
                                console.log('📅 Schedule with time range - keeping for end time execution');
                                // Marquer comme exécuté mais garder pour l'heure de fin
                                schedule.executedAt = now.toISOString();
                                schedule.lastAction = actionType;
                                
                                // Si c'est l'heure de fin, supprimer le schedule
                                if (actionType === 'STOP') {
                                    console.log('📅 Time range completed - removing schedule');
                                    const filteredSchedules = userSchedules.filter(s => s !== schedule);
                                    schedules.set(userId, filteredSchedules);
                                }
                            } else {
                                // Supprimer le schedule exécuté (schedule ponctuel)
                            const filteredSchedules = userSchedules.filter(s => s !== schedule);
                            schedules.set(userId, filteredSchedules);
                            }
                        } else {
                            console.error('❌ Failed to execute schedule for ad:', schedule.adId);
                            const errorData = await response.json();
                            console.error('❌ Facebook API error:', errorData);
                        }
                        
                    } catch (error) {
                        console.error('❌ Error executing schedule:', error);
                    }
                }
            }
        }
        
        console.log(`🕐 Schedule execution completed: ${executedSchedules}/${totalSchedules} schedules executed`);
        
    } catch (error) {
        console.error('❌ Error in executeSchedules:', error);
    }
}

// Démarrer le service de schedules (appelé toutes les minutes)
export function startScheduleService() {
    console.log('🚀 Starting schedule service...');
    
    // Exécuter toutes les 5 secondes pour les tests (changer à 60000 pour la production)
    setInterval(() => {
        console.log('⏰ Schedule service tick - executing schedules...');
        executeSchedules();
    }, 5000); // 5 secondes pour les tests
    
    // Nettoyer les schedules des tokens expirés toutes les 5 minutes
    setInterval(() => {
        console.log('🧹 Schedule cleanup tick...');
        cleanupExpiredTokenSchedules();
    }, 300000); // 5 minutes
    
    console.log('✅ Schedule service started - will execute every 60 seconds');
}

// Fonction pour tester manuellement l'exécution des schedules
export async function testExecuteSchedules(req: Request, res: Response) {
    try {
        console.log('🧪 Manual schedule execution test...');
        await executeSchedules();
        
        return res.json({
            success: true,
            message: "Schedule execution test completed"
        });
    } catch (error: any) {
        console.error('❌ Error in test execute schedules:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}


// Récupérer les analytics des schedules
export async function getScheduleAnalytics(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { startDate, endDate, action } = req.query;

        // Construire la requête de base
        let query = supabase
            .from('logs')
            .select('*')
            .eq('user_id', userId)
            .in('action', ['SCHEDULE_CREATE', 'SCHEDULE_EXECUTE', 'SCHEDULE_EXECUTE_ERROR', 'SCHEDULE_TOKEN_EXPIRED']);

        // Filtrer par date si fournie
        if (startDate) {
            query = query.gte('created_at', startDate);
        }
        if (endDate) {
            query = query.lte('created_at', endDate);
        }

        // Filtrer par action spécifique si fournie
        if (action) {
            query = query.eq('action', action);
        }

        const { data: logs, error } = await query.order('created_at', { ascending: false });
        
        if (error) {
            console.error('❌ Error fetching schedule analytics:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch schedule analytics"
            });
        }

        // Type assertion pour les logs
        const typedLogs = logs as any[];

        // Analyser les données
        const analytics = {
            totalLogs: typedLogs?.length || 0,
            byAction: {
                SCHEDULE_CREATE: 0,
                SCHEDULE_EXECUTE: 0,
                SCHEDULE_EXECUTE_ERROR: 0,
                SCHEDULE_TOKEN_EXPIRED: 0
            },
            byScheduleType: {
                START: 0,
                STOP: 0,
                PAUSE: 0
            },
            successRate: 0,
            errorRate: 0,
            recentActivity: [],
            schedulePerformance: []
        };

        // Compter les actions et types
        typedLogs?.forEach(log => {
            analytics.byAction[log.action as keyof typeof analytics.byAction]++;
            
            if (log.details?.scheduleType) {
                analytics.byScheduleType[log.details.scheduleType as keyof typeof analytics.byScheduleType]++;
            }

            // Ajouter aux activités récentes
            if (analytics.recentActivity.length < 10) {
                analytics.recentActivity.push({
                    action: log.action,
                    timestamp: log.created_at,
                    adId: log.details?.adId,
                    scheduleType: log.details?.scheduleType,
                    success: log.action === 'SCHEDULE_EXECUTE'
                });
            }
        });

        // Calculer les taux de succès
        const totalExecutions = analytics.byAction.SCHEDULE_EXECUTE + analytics.byAction.SCHEDULE_EXECUTE_ERROR;
        if (totalExecutions > 0) {
            analytics.successRate = Math.round((analytics.byAction.SCHEDULE_EXECUTE / totalExecutions) * 100);
            analytics.errorRate = Math.round((analytics.byAction.SCHEDULE_EXECUTE_ERROR / totalExecutions) * 100);
        }

        // Analyser les performances par ad
        const adPerformance = new Map();
        typedLogs?.forEach(log => {
            if (log.details?.adId) {
                const adId = log.details.adId;
                if (!adPerformance.has(adId)) {
                    adPerformance.set(adId, {
                        adId,
                        totalSchedules: 0,
                        successfulExecutions: 0,
                        failedExecutions: 0,
                        lastActivity: log.created_at
                    });
                }
                
                const performance = adPerformance.get(adId);
                if (log.action === 'SCHEDULE_CREATE') {
                    performance.totalSchedules++;
                } else if (log.action === 'SCHEDULE_EXECUTE') {
                    performance.successfulExecutions++;
                } else if (log.action === 'SCHEDULE_EXECUTE_ERROR') {
                    performance.failedExecutions++;
                }
                
                if (new Date(log.created_at) > new Date(performance.lastActivity)) {
                    performance.lastActivity = log.created_at;
                }
            }
        });

        analytics.schedulePerformance = Array.from(adPerformance.values());

        return res.json({
            success: true,
            data: analytics
        });

    } catch (error: any) {
        console.error('❌ Error in getScheduleAnalytics:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction pour forcer l'exécution immédiate d'un schedule spécifique
export async function forceExecuteSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        console.log('🚀 Force executing schedule for ad:', adId);
        
        const userSchedules = schedules.get(userId) || [];
        const schedule = userSchedules.find(s => s.adId === adId);
        
        if (!schedule) {
            return res.status(404).json({
                success: false,
                message: "No schedule found for this ad"
            });
        }
        
        console.log('🚀 Found schedule:', schedule);
        
        // Forcer l'exécution
        const now = new Date();
        console.log('🚀 Force executing at:', now.toISOString());
        
        try {
            // Récupérer le token Facebook
            const tokenRow = await getFacebookToken(userId);
            
            // Tester le token
            const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenRow.token}`);
            if (!testResponse.ok) {
                const testError = await testResponse.json();
                if (testError.error?.code === 190) {
                    return res.status(401).json({
                        success: false,
                        message: "Facebook token expired. Please reconnect your Facebook account."
                    });
                }
            }
            
            // Exécuter l'action
            let newStatus = 'ACTIVE';
            let actionDescription = 'activate';
            
            if (schedule.scheduleType === 'START') {
                newStatus = 'ACTIVE';
                actionDescription = 'activate';
            } else if (schedule.scheduleType === 'STOP' || schedule.scheduleType === 'PAUSE') {
                newStatus = 'PAUSED';
                actionDescription = 'pause/stop';
            }
            
            console.log(`🚀 Force ${actionDescription} ad ${adId} to status: ${newStatus}`);
            
            // Appeler l'API Facebook
            const response = await fetch(`https://graph.facebook.com/v18.0/${adId}`, {
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
                console.log('✅ Force execution successful for ad:', adId);
                
                // Log de l'exécution
                await createLog(userId, "SCHEDULE_EXECUTE", {
                    adId: adId,
                    scheduleType: schedule.scheduleType,
                    newStatus,
                    actionDescription,
                    executedAt: now.toISOString(),
                    forced: true
                });
                
                return res.json({
                    success: true,
                    message: `Ad ${adId} ${actionDescription}d successfully`,
                    data: {
                        adId,
                        newStatus,
                        actionDescription,
                        executedAt: now.toISOString()
                    }
                });
            } else {
                const errorData = await response.json();
                console.error('❌ Facebook API error:', errorData);
                return res.status(400).json({
                    success: false,
                    message: "Failed to update ad status",
                    error: errorData
                });
            }
            
        } catch (error: any) {
            console.error('❌ Error in force execution:', error);
            return res.status(500).json({
                success: false,
                message: error.message || "Server error"
            });
        }
        
    } catch (error: any) {
        console.error('❌ Error in force execute schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction pour afficher tous les schedules en cours (debug)
export async function debugSchedules(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const userSchedules = schedules.get(userId) || [];
        
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        
        const debugInfo = userSchedules.map(schedule => ({
            adId: schedule.adId,
            scheduleType: schedule.scheduleType,
            scheduledDate: schedule.scheduledDate,
            startMinutes: schedule.startMinutes,
            endMinutes: schedule.endMinutes,
            executedAt: schedule.executedAt,
            lastAction: schedule.lastAction,
            currentTime: now.toISOString(),
            currentMinutes: currentMinutes,
            shouldExecute: checkIfScheduleShouldExecute(schedule, now),
            startTime: schedule.startMinutes ? `${Math.floor(schedule.startMinutes / 60)}:${schedule.startMinutes % 60}` : null,
            endTime: schedule.endMinutes ? `${Math.floor(schedule.endMinutes / 60)}:${schedule.endMinutes % 60}` : null
        }));
        
        console.log('🔍 Debug schedules for user:', userId, debugInfo);
        
        return res.json({
            success: true,
            data: {
                userId,
                totalSchedules: userSchedules.length,
                currentTime: now.toISOString(),
                currentMinutes: currentMinutes,
                schedules: debugInfo
            }
        });
        
    } catch (error: any) {
        console.error('❌ Error in debug schedules:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction pour nettoyer les schedules des utilisateurs avec des tokens expirés
export async function cleanupExpiredTokenSchedules() {
    try {
        console.log('🧹 Cleaning up schedules for users with expired tokens...');
        
        for (const [userId, userSchedules] of schedules.entries()) {
            try {
                const tokenRow = await getFacebookToken(userId);
                
                // Tester le token
                const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenRow.token}`);
                if (!testResponse.ok) {
                    const testError = await testResponse.json();
                    if (testError.error?.code === 190) {
                        console.log(`🧹 Removing schedules for user ${userId} with expired token`);
                        schedules.delete(userId);
                    }
                }
            } catch (error) {
                console.log(`🧹 Removing schedules for user ${userId} (no token found)`);
                schedules.delete(userId);
            }
        }
        
        console.log('✅ Schedule cleanup completed');
    } catch (error) {
        console.error('❌ Error in schedule cleanup:', error);
    }
}

// Fonction pour créer un schedule de test (date dans le passé)
export async function createTestSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        console.log('🧪 Creating test schedule for ad:', adId);
        
        // Créer un schedule avec une date dans le passé (il s'exécutera immédiatement)
        const pastDate = new Date();
        pastDate.setMinutes(pastDate.getMinutes() - 1); // 1 minute dans le passé
        
        const scheduleData: ScheduleData = {
            adId,
            scheduleType: 'PAUSE',
            scheduledDate: pastDate.toISOString(),
            timezone: 'UTC'
        };
        
        // Stocker le schedule
        if (!schedules.has(userId)) {
            schedules.set(userId, []);
        }
        schedules.get(userId)!.push(scheduleData);
        
        console.log('✅ Test schedule created for immediate execution');
        
        return res.json({
            success: true,
            message: "Test schedule created successfully",
            data: {
                adId,
                scheduledDate: pastDate.toISOString(),
                scheduleType: 'PAUSE'
            }
        });
        
    } catch (error: any) {
        console.error('❌ Error creating test schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction pour créer un schedule de test avec plage horaire
export async function createTestTimeRangeSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        console.log('🧪 Creating test time range schedule for ad:', adId);
        
        // Créer un schedule avec plage horaire qui commence maintenant et finit dans 5 minutes
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const endMinutes = currentMinutes + 5; // Fin dans 5 minutes
        
        const scheduleData: ScheduleData = {
            adId,
            scheduleType: 'START',
            scheduledDate: now.toISOString(),
            timezone: 'UTC',
            startMinutes: currentMinutes,
            endMinutes: endMinutes
        };
        
        // Stocker le schedule
        if (!schedules.has(userId)) {
            schedules.set(userId, []);
        }
        schedules.get(userId)!.push(scheduleData);
        
        console.log('✅ Test time range schedule created:', {
            adId,
            startMinutes: currentMinutes,
            endMinutes: endMinutes,
            startTime: `${Math.floor(currentMinutes / 60)}:${currentMinutes % 60}`,
            endTime: `${Math.floor(endMinutes / 60)}:${endMinutes % 60}`,
            currentTime: now.toISOString()
        });
        
        // Test immédiat de la logique
        console.log('🧪 Testing schedule logic immediately...');
        const shouldExecute = checkIfScheduleShouldExecute(scheduleData, now);
        console.log('🧪 Should execute immediately:', shouldExecute);
        
        return res.json({
            success: true,
            message: "Test time range schedule created successfully",
            data: {
                adId,
                startMinutes: currentMinutes,
                endMinutes: endMinutes,
                startTime: `${Math.floor(currentMinutes / 60)}:${currentMinutes % 60}`,
                endTime: `${Math.floor(endMinutes / 60)}:${endMinutes % 60}`,
                currentTime: now.toISOString(),
                shouldExecuteImmediately: shouldExecute
            }
        });
        
    } catch (error: any) {
        console.error('❌ Error creating test time range schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction pour créer un schedule de test simple qui s'exécute immédiatement
export async function createImmediateTestSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        console.log('🧪 Creating immediate test schedule for ad:', adId);
        
        // Créer un schedule avec une date dans le passé pour exécution immédiate
        const pastDate = new Date();
        pastDate.setSeconds(pastDate.getSeconds() - 10); // 10 secondes dans le passé
        
        const scheduleData: ScheduleData = {
            adId,
            scheduleType: 'START',
            scheduledDate: pastDate.toISOString(),
            timezone: 'UTC'
        };
        
        // Stocker le schedule
        if (!schedules.has(userId)) {
            schedules.set(userId, []);
        }
        schedules.get(userId)!.push(scheduleData);
        
        console.log('✅ Immediate test schedule created:', {
            adId,
            scheduledDate: pastDate.toISOString(),
            currentTime: new Date().toISOString()
        });
        
        // Test immédiat de la logique
        console.log('🧪 Testing immediate schedule logic...');
        const shouldExecute = checkIfScheduleShouldExecute(scheduleData, new Date());
        console.log('🧪 Should execute immediately:', shouldExecute);
        
        return res.json({
            success: true,
            message: "Immediate test schedule created successfully",
            data: {
                adId,
                scheduledDate: pastDate.toISOString(),
                currentTime: new Date().toISOString(),
                shouldExecuteImmediately: shouldExecute
            }
        });
        
    } catch (error: any) {
        console.error('❌ Error creating immediate test schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}
