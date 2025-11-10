import { Request, Response } from "../types/express.js";
import { getFacebookToken, fetchFbGraph } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";
import { supabase } from "../supabaseClient.js";

// Interface pour les données de schedule
interface ScheduleData {
    adId: string;
    scheduleType: 'START' | 'STOP' | 'PAUSE' | 'RECURRING_DAILY';
    scheduledDate: string;
    timezone: string;
    startMinutes?: number;
    endMinutes?: number;
    stopMinutes1?: number; // STOP 1 pour recurring
    stopMinutes2?: number; // STOP 2 pour recurring
    startMinutes2?: number; // ACTIVE 2 pour recurring
    executedAt?: string; // Date de dernière exécution
    lastAction?: string; // Dernière action exécutée
    lastExecutionDate?: string; // Date de la dernière exécution (pour recurring daily)
}

// Stockage temporaire des schedules (en production, utiliser une base de données)
const schedules: Map<string, ScheduleData[]> = new Map();

// Fonction pour vérifier si un schedule doit être exécuté
function checkIfScheduleShouldExecute(schedule: ScheduleData, now: Date): { shouldExecute: boolean; action?: string } {
    const scheduledTime = new Date(schedule.scheduledDate);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const currentDate = now.toISOString().split('T')[0]; // Format: YYYY-MM-DD
    
    console.log(`🔍 Checking schedule for ad ${schedule.adId}:`, {
        scheduleType: schedule.scheduleType,
        currentMinutes,
        lastExecutionDate: schedule.lastExecutionDate,
        currentDate
    });
    
    // Gérer RECURRING_DAILY avec 4 actions
    if (schedule.scheduleType === 'RECURRING_DAILY' && 
        schedule.stopMinutes1 !== undefined && 
        schedule.startMinutes !== undefined && 
        schedule.stopMinutes2 !== undefined && 
        schedule.startMinutes2 !== undefined) {
        
        // Vérifier si on a déjà exécuté une action aujourd'hui
        if (schedule.lastExecutionDate === currentDate && schedule.lastAction) {
            console.log(`⏰ Already executed ${schedule.lastAction} today for ad ${schedule.adId}`);
            
            // Déterminer quelle est la prochaine action à exécuter
            if (schedule.lastAction === 'STOP_1' && currentMinutes >= schedule.startMinutes && currentMinutes < schedule.startMinutes + 1) {
                console.log(`🟢 Time for ACTIVE_1 at ${currentMinutes}`);
                return { shouldExecute: true, action: 'ACTIVE_1' };
            } else if (schedule.lastAction === 'ACTIVE_1' && currentMinutes >= schedule.stopMinutes2 && currentMinutes < schedule.stopMinutes2 + 1) {
                console.log(`🔴 Time for STOP_2 at ${currentMinutes}`);
                return { shouldExecute: true, action: 'STOP_2' };
            } else if (schedule.lastAction === 'STOP_2' && currentMinutes >= schedule.startMinutes2 && currentMinutes < schedule.startMinutes2 + 1) {
                console.log(`🟢 Time for ACTIVE_2 at ${currentMinutes}`);
                return { shouldExecute: true, action: 'ACTIVE_2' };
            }
        } else if (schedule.lastExecutionDate !== currentDate) {
            // Nouveau jour - vérifier quelle action doit être exécutée
            if (currentMinutes >= schedule.stopMinutes1 && currentMinutes < schedule.stopMinutes1 + 1) {
                console.log(`🔴 Time for STOP_1 (new day) at ${currentMinutes}`);
                return { shouldExecute: true, action: 'STOP_1' };
            } else if (currentMinutes >= schedule.startMinutes && currentMinutes < schedule.startMinutes + 1) {
                console.log(`🟢 Time for ACTIVE_1 (new day) at ${currentMinutes}`);
                return { shouldExecute: true, action: 'ACTIVE_1' };
            } else if (currentMinutes >= schedule.stopMinutes2 && currentMinutes < schedule.stopMinutes2 + 1) {
                console.log(`🔴 Time for STOP_2 (new day) at ${currentMinutes}`);
                return { shouldExecute: true, action: 'STOP_2' };
            } else if (currentMinutes >= schedule.startMinutes2 && currentMinutes < schedule.startMinutes2 + 1) {
                console.log(`🟢 Time for ACTIVE_2 (new day) at ${currentMinutes}`);
                return { shouldExecute: true, action: 'ACTIVE_2' };
            }
        }
        
        console.log(`⏰ No action needed for recurring ad ${schedule.adId} at ${currentMinutes} minutes`);
        return { shouldExecute: false };
    }
    
    // Vérifier si c'est un schedule avec plage horaire (ancien système)
    if (schedule.startMinutes !== undefined && schedule.endMinutes !== undefined) {
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
            return { shouldExecute: true, action: 'START' };
        }
        
        // Si c'est l'heure de fin
        if (schedule.executedAt && schedule.lastAction === 'START' && currentMinutes >= schedule.endMinutes) {
            console.log(`🕐 Time to STOP ad ${schedule.adId} (current: ${currentMinutes}, end: ${schedule.endMinutes})`);
            return { shouldExecute: true, action: 'STOP' };
        }
        
        console.log(`⏰ No action needed for ad ${schedule.adId} at ${currentMinutes} minutes`);
        return { shouldExecute: false };
    }
    
    // Schedule ponctuel - exécuter si la date/heure est atteinte
    const shouldExecute = now >= scheduledTime;
    console.log(`🕐 Schedule check for ad ${schedule.adId}: now=${now.toISOString()}, scheduled=${scheduledTime.toISOString()}, shouldExecute=${shouldExecute}`);
    return { shouldExecute, action: schedule.scheduleType };
}

// Créer un schedule pour une ad
export async function createSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { scheduleType, scheduledDate, timezone, startMinutes, endMinutes, stopMinutes1, stopMinutes2, startMinutes2 } = req.body;

        console.log('🔍 Creating schedule for ad:', adId, 'Type:', scheduleType);
        console.log('🔍 Request body:', req.body);
        console.log('🔍 User ID:', userId);
        console.log('🔍 Recurring times:', { stopMinutes1, startMinutes, stopMinutes2, startMinutes2 });

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
        
        // Validation pour recurring daily (4 temps)
        if (stopMinutes1 !== undefined && (stopMinutes1 < 0 || stopMinutes1 > 1439)) {
            return res.status(400).json({
                success: false,
                message: "Invalid stopMinutes1. Must be between 0 and 1439."
            });
        }
        
        if (stopMinutes2 !== undefined && (stopMinutes2 < 0 || stopMinutes2 > 1439)) {
            return res.status(400).json({
                success: false,
                message: "Invalid stopMinutes2. Must be between 0 and 1439."
            });
        }
        
        if (startMinutes2 !== undefined && (startMinutes2 < 0 || startMinutes2 > 1439)) {
            return res.status(400).json({
                success: false,
                message: "Invalid startMinutes2. Must be between 0 and 1439."
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
            endMinutes,
            stopMinutes1,
            stopMinutes2,
            startMinutes2
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
        const now = new Date();
        let totalSchedules = 0;
        let executedSchedules = 0;
        
        // Compter le nombre total de schedules
        for (const userSchedules of schedules.values()) {
            totalSchedules += userSchedules.length;
        }
        
        // Ne logger que s'il y a des schedules actifs
        if (totalSchedules > 0) {
            console.log(`🕐 Checking ${totalSchedules} active schedule(s)...`);
        }
        
        for (const [userId, userSchedules] of schedules.entries()) {
            
            for (const schedule of userSchedules) {
                // Vérifier si le schedule doit être exécuté maintenant
                const checkResult = checkIfScheduleShouldExecute(schedule, now);
                if (checkResult.shouldExecute && checkResult.action) {
                    console.log(`⚡ Executing schedule for ad ${schedule.adId} - Action: ${checkResult.action}`);
                    
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
                        
                        // Exécuter l'action selon le type
                        let newStatus = 'ACTIVE';
                        let actionDescription = 'activate';
                        const actionType = checkResult.action!;
                        
                        // Déterminer le statut selon l'action
                        if (actionType === 'STOP_1' || actionType === 'STOP_2' || actionType === 'STOP' || actionType === 'PAUSE') {
                            newStatus = 'PAUSED';
                            actionDescription = actionType === 'STOP_1' ? 'stop (STOP 1)' : 
                                               actionType === 'STOP_2' ? 'stop (STOP 2)' : 'stop';
                        } else if (actionType === 'ACTIVE_1' || actionType === 'ACTIVE_2' || actionType === 'START') {
                            newStatus = 'ACTIVE';
                            actionDescription = actionType === 'ACTIVE_1' ? 'activate (ACTIVE 1)' : 
                                               actionType === 'ACTIVE_2' ? 'activate (ACTIVE 2)' : 'activate';
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
                            
                            // Gérer la persistance du schedule selon le type
                            if (schedule.scheduleType === 'RECURRING_DAILY') {
                                // Pour recurring daily, garder le schedule et mettre à jour les infos d'exécution
                                console.log('🔁 Recurring daily schedule - keeping for next execution');
                                const currentDate = now.toISOString().split('T')[0];
                                schedule.lastExecutionDate = currentDate;
                                schedule.lastAction = actionType;
                                schedule.executedAt = now.toISOString();
                                console.log(`✅ Updated recurring schedule: lastAction=${actionType}, lastExecutionDate=${currentDate}`);
                            } else if (schedule.startMinutes !== undefined && schedule.endMinutes !== undefined) {
                                // Pour les schedules avec plages horaires (ancien système)
                                console.log('📅 Schedule with time range - keeping for end time execution');
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
                                console.log('📅 One-time schedule - removing after execution');
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
        
        // Logger uniquement s'il y a eu des exécutions
        if (executedSchedules > 0) {
            console.log(`✅ Schedule execution completed: ${executedSchedules}/${totalSchedules} schedules executed`);
        }
        
    } catch (error) {
        console.error('❌ Error in executeSchedules:', error);
    }
}

// Démarrer le service de schedules (appelé toutes les minutes)
export function startScheduleService() {
    console.log('🚀 Schedule service started - checking every 5 seconds');
    
    // Exécuter toutes les 5 secondes pour les tests (changer à 60000 pour la production)
    setInterval(() => {
        executeSchedules();
    }, 5000); // 5 secondes pour les tests
    
    // Nettoyer les schedules des tokens expirés toutes les 5 minutes
    setInterval(() => {
        cleanupExpiredTokenSchedules();
    }, 300000); // 5 minutes
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
        let cleanedUsers = 0;
        
        for (const [userId, userSchedules] of schedules.entries()) {
            try {
                const tokenRow = await getFacebookToken(userId);
                
                // Tester le token
                const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenRow.token}`);
                if (!testResponse.ok) {
                    const testError = await testResponse.json();
                    if (testError.error?.code === 190) {
                        console.log(`🧹 Removing ${userSchedules.length} schedule(s) for user ${userId} (expired token)`);
                        schedules.delete(userId);
                        cleanedUsers++;
                    }
                }
            } catch (error) {
                console.log(`🧹 Removing ${userSchedules.length} schedule(s) for user ${userId} (no token found)`);
                schedules.delete(userId);
                cleanedUsers++;
            }
        }
        
        // Logger uniquement s'il y a eu des nettoyages
        if (cleanedUsers > 0) {
            console.log(`✅ Schedule cleanup completed: ${cleanedUsers} user(s) cleaned`);
        }
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

// Fonction pour récupérer les schedules actifs d'une ad
export async function getAdSchedules(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        console.log('🔍 Getting schedules for ad:', adId);
        
        const userSchedules = schedules.get(userId) || [];
        const adSchedules = userSchedules.filter(s => s.adId === adId);
        
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        
        const schedulesInfo = adSchedules.map(schedule => ({
            adId: schedule.adId,
            scheduleType: schedule.scheduleType,
            scheduledDate: schedule.scheduledDate,
            timezone: schedule.timezone,
            startMinutes: schedule.startMinutes,
            endMinutes: schedule.endMinutes,
            stopMinutes1: schedule.stopMinutes1,
            stopMinutes2: schedule.stopMinutes2,
            startMinutes2: schedule.startMinutes2,
            executedAt: schedule.executedAt,
            lastAction: schedule.lastAction,
            lastExecutionDate: schedule.lastExecutionDate,
            isRecurring: schedule.scheduleType === 'RECURRING_DAILY',
            startTime: schedule.startMinutes ? `${Math.floor(schedule.startMinutes / 60)}:${(schedule.startMinutes % 60).toString().padStart(2, '0')}` : null,
            endTime: schedule.endMinutes ? `${Math.floor(schedule.endMinutes / 60)}:${(schedule.endMinutes % 60).toString().padStart(2, '0')}` : null,
            stopTime1: schedule.stopMinutes1 ? `${Math.floor(schedule.stopMinutes1 / 60)}:${(schedule.stopMinutes1 % 60).toString().padStart(2, '0')}` : null,
            stopTime2: schedule.stopMinutes2 ? `${Math.floor(schedule.stopMinutes2 / 60)}:${(schedule.stopMinutes2 % 60).toString().padStart(2, '0')}` : null,
            startTime2: schedule.startMinutes2 ? `${Math.floor(schedule.startMinutes2 / 60)}:${(schedule.startMinutes2 % 60).toString().padStart(2, '0')}` : null
        }));
        
        console.log('✅ Found schedules for ad:', schedulesInfo);
        
        return res.json({
            success: true,
            data: {
                adId,
                totalSchedules: adSchedules.length,
                currentTime: now.toISOString(),
                currentMinutes,
                schedules: schedulesInfo
            }
        });
        
    } catch (error: any) {
        console.error('❌ Error getting ad schedules:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction pour supprimer les schedules d'une ad
export async function deleteAdSchedules(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        console.log('🗑️ Deleting schedules for ad:', adId);
        
        const userSchedules = schedules.get(userId) || [];
        const initialCount = userSchedules.length;
        
        // Filter out all schedules for this ad
        const filteredSchedules = userSchedules.filter(s => s.adId !== adId);
        const deletedCount = initialCount - filteredSchedules.length;
        
        schedules.set(userId, filteredSchedules);
        
        console.log(`✅ Deleted ${deletedCount} schedule(s) for ad ${adId}`);
        
        return res.json({
            success: true,
            message: `Successfully deleted ${deletedCount} schedule(s)`,
            data: {
                adId,
                deletedCount,
                remainingSchedules: filteredSchedules.length
            }
        });
        
    } catch (error: any) {
        console.error('❌ Error deleting ad schedules:', error);
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

// 🛑 Fonction pour vérifier les conditions de stop loss
export async function checkStopLossConditions(userId: string, adId: string): Promise<{ shouldStop: boolean; reason?: string; threshold?: number }> {
    try {
        // Récupérer les métriques de l'ad
        const tokenRow = await getFacebookToken(userId);
        
        // Récupérer les insights de l'ad pour les dernières 24h
        const insightsUrl = `https://graph.facebook.com/v18.0/${adId}/insights?access_token=${tokenRow.token}&fields=spend,actions&date_preset=today`;
        const insightsResponse = await fetch(insightsUrl);
        const insightsData = await insightsResponse.json();
        
        if (insightsData.error) {
            console.error('❌ Error fetching ad insights for stop loss:', insightsData.error);
            return { shouldStop: false };
        }
        
        const insights = insightsData.data?.[0];
        if (!insights) {
            console.log('📊 No insights data for ad:', adId);
            return { shouldStop: false };
        }
        
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
        
        console.log(`🔍 Stop loss check for ad ${adId}: spend=$${spend.toFixed(2)}, results=${results}`);
        
        // Vérifier les conditions de stop loss pour cette ad spécifique
        const { data: stopLossConfig } = await supabase
            .from('stop_loss_settings')
            .select('*')
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .eq('enabled', true)
            .single();

        if (stopLossConfig) {
            // S'assurer que les seuils sont bien des nombres
            const costPerResultThreshold = stopLossConfig.cost_per_result_threshold ? parseFloat(String(stopLossConfig.cost_per_result_threshold)) : null;
            const zeroResultsSpendThreshold = stopLossConfig.zero_results_spend_threshold ? parseFloat(String(stopLossConfig.zero_results_spend_threshold)) : null;
            
            // Vérifier quels seuils sont activés (par défaut true si null pour rétrocompatibilité)
            const cprEnabled = stopLossConfig.cpr_enabled !== null ? stopLossConfig.cpr_enabled : true;
            const zeroResultsEnabled = stopLossConfig.zero_results_enabled !== null ? stopLossConfig.zero_results_enabled : true;
            
            console.log(`🔍 Stop loss config found: cost_per_result_threshold=${costPerResultThreshold}, zero_results_spend_threshold=${zeroResultsSpendThreshold}`);
            console.log(`🔍 Thresholds enabled: cpr_enabled=${cprEnabled}, zero_results_enabled=${zeroResultsEnabled}`);
            console.log(`🔍 Config types: cost_per_result_threshold type=${typeof costPerResultThreshold}, zero_results_spend_threshold type=${typeof zeroResultsSpendThreshold}`);
            console.log(`🔍 Spend type: ${typeof spend}, value: ${spend}`);
            
            let shouldStop = false;
            let reason = '';
            let threshold: number | undefined;

            // Vérifier le cost per result si il y a des résultats ET que le seuil est activé
            if (results > 0 && costPerResultThreshold !== null && cprEnabled) {
                const costPerResult = spend / results;
                console.log(`🔍 Cost per result: $${costPerResult.toFixed(2)} vs threshold: $${costPerResultThreshold}`);
                console.log(`🔍 Comparison: ${costPerResult} >= ${costPerResultThreshold} = ${costPerResult >= costPerResultThreshold}`);
                if (costPerResult >= costPerResultThreshold) {
                    shouldStop = true;
                    threshold = costPerResultThreshold;
                    reason = `Cost per result ($${costPerResult.toFixed(2)}) exceeds threshold ($${costPerResultThreshold})`;
                }
            }
            // Vérifier le zero results spend si il n'y a pas de résultats ET que le seuil est activé
            if (results === 0 && zeroResultsSpendThreshold !== null && zeroResultsEnabled) {
                console.log(`🔍 Zero results spend: $${spend.toFixed(2)} vs threshold: $${zeroResultsSpendThreshold}`);
                console.log(`🔍 Comparison: ${spend} >= ${zeroResultsSpendThreshold} = ${spend >= zeroResultsSpendThreshold}`);
                if (spend >= zeroResultsSpendThreshold) {
                    shouldStop = true;
                    threshold = zeroResultsSpendThreshold;
                    reason = `Ad spend ($${spend.toFixed(2)}) exceeds zero results threshold ($${zeroResultsSpendThreshold})`;
                }
            }
            
            if (!shouldStop) {
                console.log(`⚠️ No stop loss condition met: results=${results}, cprEnabled=${cprEnabled}, zeroResultsEnabled=${zeroResultsEnabled}, costPerResultThreshold=${costPerResultThreshold}, zeroResultsSpendThreshold=${zeroResultsSpendThreshold}`);
            }

            if (shouldStop) {
                console.log(`🛑 STOP LOSS TRIGGERED for ad ${adId}: ${reason}`);
                
                // Arrêter l'annonce
                try {
                    const stopResponse = await fetch(`https://graph.facebook.com/v18.0/${adId}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            status: 'PAUSED',
                            access_token: tokenRow.token
                        })
                    });

                    if (stopResponse.ok) {
                        console.log(`✅ Ad ${adId} paused successfully due to stop loss`);
                        
                        // Désactiver la configuration stop loss après exécution
                        const { StopLossSettingsService } = await import('../services/stopLossSettingsService.js');
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
                                    reason: reason,
                                    triggered_at: new Date().toISOString(),
                                    threshold: threshold,
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
                            console.error(`❌ Error creating notification for ad ${adId}:`, notifErr);
                            console.error(`❌ Error stack:`, (notifErr as any).stack);
                        }
                    } else {
                        const errorData = await stopResponse.json();
                        console.error(`❌ Failed to pause ad ${adId}:`, errorData);
                    }
                } catch (stopError) {
                    console.error(`❌ Error pausing ad ${adId}:`, stopError);
                }
                
                // Logger l'action de stop loss
                await createLog(userId, 'STOP_LOSS_TRIGGERED', {
                    adId,
                    spend,
                    results,
                    reason,
                    threshold: threshold,
                    timestamp: new Date().toISOString()
                });
                
                return { shouldStop: true, reason, threshold };
            }
        }
        
        return { shouldStop: false };
    } catch (error) {
        console.error('❌ Error checking stop loss conditions:', error);
        return { shouldStop: false };
    }
}
