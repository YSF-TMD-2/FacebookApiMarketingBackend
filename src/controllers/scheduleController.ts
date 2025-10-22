import { Request, Response } from "../types/express.js";
import { getFacebookToken } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";

// Interface pour les données de schedule
interface ScheduleData {
    adId: string;
    scheduleType: 'START' | 'STOP' | 'PAUSE';
    scheduledDate: string;
    timezone: string;
    startMinutes?: number;
    endMinutes?: number;
}

// Stockage temporaire des schedules (en production, utiliser une base de données)
const schedules: Map<string, ScheduleData[]> = new Map();

// Créer un schedule pour une ad
export async function createSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { scheduleType, scheduledDate, timezone, startMinutes, endMinutes } = req.body;

        console.log('🔍 Creating schedule for ad:', adId, 'Type:', scheduleType);

        // Valider les paramètres
        if (!scheduleType || !scheduledDate || !timezone) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters: scheduleType, scheduledDate, timezone"
            });
        }

        // Récupérer le token Facebook
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les détails de l'ad pour logging
        let adDetails = null;
        try {
            const fbResponse = await fetch(`https://graph.facebook.com/v18.0/${adId}?fields=id,name,status,adset_id&access_token=${tokenRow.token}`);
            adDetails = await fbResponse.json();
        } catch (error) {
            console.log('⚠️ Could not fetch ad details:', error);
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

        // Stocker le schedule (en production, sauvegarder en base de données)
        if (!schedules.has(userId)) {
            schedules.set(userId, []);
        }
        schedules.get(userId)!.push(scheduleData);

        // Log de création
        await createLog(userId, "SCHEDULE_CREATED", {
            adId,
            adName: adDetails?.name || 'Unknown',
            scheduleType,
            scheduledDate,
            timezone,
            startMinutes,
            endMinutes
        });

        console.log('✅ Schedule created successfully for ad:', adId);

        return res.json({
            success: true,
            message: "Schedule created successfully",
            data: {
                scheduleId: `${adId}_${Date.now()}`,
                adId,
                scheduleType,
                scheduledDate,
                timezone
            }
        });

    } catch (error: any) {
        console.error('❌ Error creating schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// Récupérer les schedules d'un utilisateur
export async function getSchedules(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const userSchedules = schedules.get(userId) || [];

        return res.json({
            success: true,
            data: userSchedules
        });

    } catch (error: any) {
        console.error('❌ Error fetching schedules:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Supprimer un schedule
export async function deleteSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { scheduleId } = req.params;

        const userSchedules = schedules.get(userId) || [];
        const filteredSchedules = userSchedules.filter(schedule => 
            `${schedule.adId}_${schedule.scheduledDate}` !== scheduleId
        );

        schedules.set(userId, filteredSchedules);

        await createLog(userId, "SCHEDULE_DELETED", { scheduleId });

        return res.json({
            success: true,
            message: "Schedule deleted successfully"
        });

    } catch (error: any) {
        console.error('❌ Error deleting schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Exécuter les schedules (à appeler périodiquement)
export async function executeSchedules() {
    try {
        console.log('🕐 Executing scheduled tasks...');
        
        const now = new Date();
        
        for (const [userId, userSchedules] of schedules.entries()) {
            for (const schedule of userSchedules) {
                const scheduledTime = new Date(schedule.scheduledDate);
                
                // Vérifier si le schedule doit être exécuté maintenant
                if (now >= scheduledTime) {
                    console.log('⚡ Executing schedule for ad:', schedule.adId, 'Type:', schedule.scheduleType);
                    
                    try {
                        // Récupérer le token Facebook
                        const tokenRow = await getFacebookToken(userId);
                        
                        // Exécuter l'action selon le type
                        let newStatus = 'ACTIVE';
                        if (schedule.scheduleType === 'STOP' || schedule.scheduleType === 'PAUSE') {
                            newStatus = 'PAUSED';
                        }
                        
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
                        
                        if (response.ok) {
                            console.log('✅ Schedule executed successfully for ad:', schedule.adId);
                            
                            // Log de l'exécution
                            await createLog(userId, "SCHEDULE_EXECUTED", {
                                adId: schedule.adId,
                                scheduleType: schedule.scheduleType,
                                newStatus,
                                executedAt: now.toISOString()
                            });
                            
                            // Supprimer le schedule exécuté
                            const filteredSchedules = userSchedules.filter(s => s !== schedule);
                            schedules.set(userId, filteredSchedules);
                        } else {
                            console.error('❌ Failed to execute schedule for ad:', schedule.adId);
                        }
                        
                    } catch (error) {
                        console.error('❌ Error executing schedule:', error);
                    }
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Error in executeSchedules:', error);
    }
}

// Démarrer le service de schedules (appelé toutes les minutes)
export function startScheduleService() {
    console.log('🚀 Starting schedule service...');
    
    // Exécuter toutes les minutes
    setInterval(executeSchedules, 60000); // 60 secondes
    
    console.log('✅ Schedule service started');
}
