/**
 * Calendar Schedule Controller - Optimisé pour grandes quantités d'annonces
 * Gère les schedules calendrier avec optimisations SQL et cache
 */

import { Request, Response } from "../types/express.js";
import { supabase } from "../supabaseClient.js";
import { getFacebookToken } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";
import { CalendarScheduleData, TimeSlot, DaySchedule, getCurrentDateInTimezone, getCurrentMinutesInTimezone, isTimeMatch, disableRecurringScheduleForAd } from "./scheduleController.js";

// Cache pour les schedules calendrier (optimisation pour requêtes fréquentes)
const calendarSchedulesCache: Map<string, CalendarScheduleData> = new Map();
const CALENDAR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const calendarCacheTimestamps: Map<string, number> = new Map();

// Fonction pour obtenir la clé de cache
function getCacheKey(userId: string, adId: string): string {
    return `${userId}:${adId}`;
}

// Fonction pour nettoyer le cache calendrier
function cleanupCalendarCache() {
    const now = Date.now();
    for (const [key, timestamp] of calendarCacheTimestamps.entries()) {
        if (now - timestamp > CALENDAR_CACHE_TTL) {
            calendarSchedulesCache.delete(key);
            calendarCacheTimestamps.delete(key);
        }
    }
}

// Nettoyer le cache toutes les 5 minutes
setInterval(cleanupCalendarCache, CALENDAR_CACHE_TTL);

// Fonction pour charger depuis le cache ou la DB (optimisée)
async function getCalendarScheduleFromCacheOrDB(userId: string, adId: string): Promise<CalendarScheduleData | null> {
    const cacheKey = getCacheKey(userId, adId);
    const cached = calendarSchedulesCache.get(cacheKey);
    const cacheTimestamp = calendarCacheTimestamps.get(cacheKey);

    // Vérifier si le cache est valide
    if (cached && cacheTimestamp && Date.now() - cacheTimestamp < CALENDAR_CACHE_TTL) {
        return cached;
    }

    // Charger depuis la DB avec requête optimisée (index sur user_id, ad_id)
    const { data, error } = await supabase
        .from('calendar_schedules')
        .select('*')
        .eq('user_id', userId)
        .eq('ad_id', adId)
        .single();

    if (error) {
        if (error.code === 'PGRST116') {
            // Pas de schedule trouvé
            return null;
        }
        console.error('❌ Error loading calendar schedule from DB:', error);
        return null;
    }

    if (!data) {
        return null;
    }

    // Convertir vers CalendarScheduleData et s'assurer que enabled est toujours défini pour chaque slot
    const scheduleData = data.schedule_data || {};
    const normalizedSchedules: { [date: string]: DaySchedule } = {};

    // Normaliser les schedules pour garantir que enabled est toujours défini
    for (const [date, daySchedule] of Object.entries(scheduleData)) {
        const day = daySchedule as DaySchedule;
        if (day.timeSlots && Array.isArray(day.timeSlots)) {
            normalizedSchedules[date] = {
                timeSlots: day.timeSlots.map(slot => ({
                    ...slot,
                    enabled: slot.enabled !== undefined ? slot.enabled : true // Garantir que enabled est toujours défini
                }))
            };
        } else {
            normalizedSchedules[date] = day;
        }
    }

    const calendarSchedule: CalendarScheduleData = {
        adId: data.ad_id,
        scheduleType: 'CALENDAR_SCHEDULE',
        timezone: data.timezone,
        schedules: normalizedSchedules,
        lastExecutedDate: data.last_executed_date || undefined,
        lastExecutedSlotId: data.last_executed_slot_id || undefined,
        lastExecutedAction: data.last_executed_action || undefined,
        createdAt: data.created_at,
        updatedAt: data.updated_at
    };

    // Mettre en cache
    calendarSchedulesCache.set(cacheKey, calendarSchedule);
    calendarCacheTimestamps.set(cacheKey, Date.now());

    return calendarSchedule;
}

// Fonction pour invalider le cache
function invalidateCalendarCache(userId: string, adId: string) {
    const cacheKey = getCacheKey(userId, adId);
    calendarSchedulesCache.delete(cacheKey);
    calendarCacheTimestamps.delete(cacheKey);
}

// GET /api/schedules/calendar/:adId - Récupérer le schedule calendrier (optimisé)
export async function getCalendarSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;


        // Utiliser le cache pour éviter les requêtes DB fréquentes
        const calendarSchedule = await getCalendarScheduleFromCacheOrDB(userId, adId);

        if (!calendarSchedule) {
            return res.json({
                success: true,
                data: null,
                message: "No calendar schedule found for this ad"
            });
        }

        return res.json({
            success: true,
            data: calendarSchedule,
            cached: calendarCacheTimestamps.has(getCacheKey(userId, adId))
        });

    } catch (error: any) {
        console.error('❌ Error getting calendar schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error getting calendar schedule"
        });
    }
}

// GET /api/schedules/calendar/:adId/all - Récupérer tous les schedules configurés avec leur état
export async function getAllCalendarSchedules(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;

        console.log(`📅 Getting all calendar schedules for ad ${adId}`);

        // Charger le schedule depuis la DB
        const { data, error } = await supabase
            .from('calendar_schedules')
            .select('*')
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.json({
                    success: true,
                    data: [],
                    message: "No calendar schedules found for this ad"
                });
            }
            console.error('❌ Error loading calendar schedules from DB:', error);
            return res.status(500).json({
                success: false,
                message: error.message || "Error loading calendar schedules"
            });
        }

        if (!data || !data.schedule_data) {
            return res.json({
                success: true,
                data: [],
                message: "No schedules configured"
            });
        }

        const scheduleData = data.schedule_data as { [date: string]: DaySchedule };
        const timezone = data.timezone || 'UTC';
        const now = new Date();
        const today = getCurrentDateInTimezone(timezone);

        // Convertir toutes les dates en format lisible avec leur état
        const allSchedules = Object.entries(scheduleData).map(([date, daySchedule]) => {
            const scheduleDate = new Date(date + 'T00:00:00');
            const isPast = scheduleDate < new Date(today + 'T00:00:00');
            const isToday = date === today;

            // Déterminer l'état de chaque slot
            const slotsWithStatus = daySchedule.timeSlots.map(slot => {
                const currentMinutes = getCurrentMinutesInTimezone(timezone);
                let status: 'completed' | 'active' | 'upcoming' | 'past' = 'past';

                if (isToday) {
                    // Si c'est aujourd'hui, vérifier l'état du slot
                    if (currentMinutes >= slot.startMinutes && currentMinutes < slot.stopMinutes) {
                        status = 'active';
                    } else if (currentMinutes >= slot.stopMinutes) {
                        status = 'completed';
                    } else {
                        status = 'upcoming';
                    }
                } else if (isPast) {
                    status = 'completed';
                } else {
                    status = 'upcoming';
                }

                return {
                    ...slot,
                    status,
                    startTime: formatMinutesToTime(slot.startMinutes),
                    stopTime: formatMinutesToTime(slot.stopMinutes)
                };
            });

            return {
                date,
                dateFormatted: formatDate(date),
                isPast,
                isToday,
                timezone,
                timeSlots: slotsWithStatus,
                totalSlots: daySchedule.timeSlots.length
            };
        });

        // Trier par date (plus récent en premier)
        allSchedules.sort((a, b) => {
            const dateA = new Date(a.date + 'T00:00:00');
            const dateB = new Date(b.date + 'T00:00:00');
            return dateB.getTime() - dateA.getTime();
        });

        return res.json({
            success: true,
            data: {
                schedules: allSchedules,
                total: allSchedules.length,
                pastCount: allSchedules.filter(s => s.isPast).length,
                upcomingCount: allSchedules.filter(s => !s.isPast).length,
                timezone
            }
        });

    } catch (error: any) {
        console.error('❌ Error getting all calendar schedules:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error getting all calendar schedules"
        });
    }
}

// Fonction helper pour formater les minutes en heure
function formatMinutesToTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${mins.toString().padStart(2, '0')} ${period}`;
}

// Fonction helper pour formater la date
function formatDate(dateString: string): string {
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}

// Fonction de validation des slots pour un jour
// Vérifie:
// 1. Maximum 2 slots par jour
// 2. Minimum 1 heure (60 minutes) entre chaque stop et le start suivant
function validateDaySlots(date: string, timeSlots: TimeSlot[]): { valid: boolean; message?: string } {
    // Vérifier le nombre maximum de slots (2 maximum)
    if (timeSlots.length > 2) {
        return {
            valid: false,
            message: `Maximum 2 time slots allowed per day. You have ${timeSlots.length} slots for date ${date}.`
        };
    }

    // Si aucun slot ou un seul slot, c'est valide
    if (timeSlots.length <= 1) {
        return { valid: true };
    }

    // Trier les slots par startMinutes pour faciliter la vérification
    const sortedSlots = [...timeSlots].sort((a, b) => a.startMinutes - b.startMinutes);

    // Vérifier qu'il y a au moins 1 heure (60 minutes) entre le stop du premier slot et le start du second
    const firstSlot = sortedSlots[0];
    const secondSlot = sortedSlots[1];

    // Calculer la différence entre le stop du premier slot et le start du second
    const timeDiff = secondSlot.startMinutes - firstSlot.stopMinutes;

    // Vérifier qu'il y a au moins 60 minutes entre le stop et le start suivant
    if (timeDiff < 60) {
        return {
            valid: false,
            message: `There must be at least 1 hour (60 minutes) between the end of one slot and the start of the next. For date ${date}, the gap between the first slot (ends at ${formatMinutesToTime(firstSlot.stopMinutes)}) and the second slot (starts at ${formatMinutesToTime(secondSlot.startMinutes)}) is only ${timeDiff} minutes. Please ensure the first slot ends at least 1 hour before the second slot starts.`
        };
    }

    return { valid: true };
}

// POST /api/schedules/calendar/:adId - Créer un schedule calendrier (optimisé avec UPSERT)
export async function createCalendarSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { timezone, schedules } = req.body;

        console.log(`📅 Creating calendar schedule for ad ${adId}`);

        // Validation
        if (!timezone || !schedules || typeof schedules !== 'object') {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters: timezone, schedules"
            });
        }

        // Valider la structure des schedules
        for (const [date, daySchedule] of Object.entries(schedules)) {
            // Valider format de date (YYYY-MM-DD)
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid date format: ${date}. Expected YYYY-MM-DD`
                });
            }

            const day = daySchedule as DaySchedule;
            if (!day.timeSlots || !Array.isArray(day.timeSlots)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid timeSlots for date ${date}`
                });
            }

            // Valider chaque slot
            for (const slot of day.timeSlots) {
                if (slot.startMinutes < 0 || slot.startMinutes > 1439 ||
                    slot.stopMinutes < 0 || slot.stopMinutes > 1439) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid time slot for date ${date}: minutes must be between 0-1439`
                    });
                }

                if (slot.startMinutes >= slot.stopMinutes) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid time slot for date ${date}: startMinutes must be less than stopMinutes`
                    });
                }

                // Vérifier que la durée du slot est d'au moins 1 heure (60 minutes)
                const slotDuration = slot.stopMinutes - slot.startMinutes;
                if (slotDuration < 60) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid time slot for date ${date}: Each time slot must have a minimum duration of 1 hour (60 minutes). The slot from ${formatMinutesToTime(slot.startMinutes)} to ${formatMinutesToTime(slot.stopMinutes)} is only ${slotDuration} minutes.`
                    });
                }

                // Générer ID si manquant
                if (!slot.id) {
                    slot.id = `${date}-${slot.startMinutes}-${slot.stopMinutes}-${Date.now()}`;
                }

                // Définir enabled par défaut
                if (slot.enabled === undefined) {
                    slot.enabled = true;
                }
            }

            // Valider les règles de slots (max 2 par jour, min 1h entre activation/stop)
            const validation = validateDaySlots(date, day.timeSlots);
            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    message: validation.message
                });
            }
        }

        // Vérifier le token Facebook
        const tokenRow = await getFacebookToken(userId);
        if (!tokenRow || !tokenRow.token) {
            return res.status(400).json({
                success: false,
                message: "No Facebook token found. Please reconnect your Facebook account."
            });
        }

        // Désactiver le schedule récurrent si présent (le schedule calendrier prend la priorité)
        try {
            await disableRecurringScheduleForAd(userId, adId);
            await createLog(userId, "RECURRING_SCHEDULE_DISABLED", {
                adId,
                reason: "Calendar schedule created"
            });
        } catch (deleteError) {
            console.error('⚠️ Error disabling recurring schedule:', deleteError);
            // Ne pas faire échouer l'opération principale si la désactivation échoue
        }

        // Utiliser UPSERT pour éviter les conflits (optimisé)
        const { data, error } = await supabase
            .from('calendar_schedules')
            .upsert({
                user_id: userId,
                ad_id: adId,
                timezone: timezone,
                schedule_data: schedules,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'user_id,ad_id',
                ignoreDuplicates: false
            })
            .select()
            .single();

        if (error) {
            console.error('❌ Error creating calendar schedule:', error);
            return res.status(500).json({
                success: false,
                message: "Error saving calendar schedule",
                error: error.message
            });
        }

        // Invalider le cache
        invalidateCalendarCache(userId, adId);

        // Log (utiliser try-catch pour ne pas faire échouer l'opération principale)
        try {
            await createLog(userId, "CALENDAR_SCHEDULE_CREATE", {
                adId,
                timezone,
                totalDays: Object.keys(schedules).length,
                totalSlots: Object.values(schedules).reduce((sum: number, day: any) =>
                    sum + (day.timeSlots?.length || 0), 0
                )
            });
        } catch (logError) {
            // Ignorer les erreurs de logging pour ne pas faire échouer l'opération principale
            console.error('⚠️ Error creating log (non-blocking):', logError);
        }

        return res.json({
            success: true,
            message: "Calendar schedule created successfully",
            data: {
                id: data.id,
                adId: data.ad_id,
                timezone: data.timezone,
                totalDays: Object.keys(schedules).length
            }
        });

    } catch (error: any) {
        console.error('❌ Error creating calendar schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error creating calendar schedule"
        });
    }
}

// PUT /api/schedules/calendar/:adId - Mettre à jour le schedule calendrier (optimisé avec merge)
export async function updateCalendarSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { schedules, timezone } = req.body;

        console.log(`📅 Updating calendar schedule for ad ${adId}`);
        console.log(`📅 [UPDATE] Received schedules for dates:`, Object.keys(schedules || {}));

        // Charger le schedule existant
        const existing = await getCalendarScheduleFromCacheOrDB(userId, adId);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Calendar schedule not found. Use POST to create one."
            });
        }

        console.log(`📅 [UPDATE] Existing schedule has dates:`, Object.keys(existing.schedules || {}));
        // Log des slots existants pour chaque date modifiée
        for (const date of Object.keys(schedules || {})) {
            const existingDay = existing.schedules[date];
            const newDay = schedules[date];
            console.log(`📅 [UPDATE] Date ${date}: existing slots=${existingDay?.timeSlots?.length || 0}, new slots=${newDay?.timeSlots?.length || 0}`);
            if (existingDay?.timeSlots) {
                existingDay.timeSlots.forEach((slot: any, idx: number) => {
                    console.log(`📅 [UPDATE] Existing slot ${idx}: id=${slot.id}, enabled=${slot.enabled}, start=${slot.startMinutes}, stop=${slot.stopMinutes}`);
                });
            }
            if (newDay?.timeSlots) {
                newDay.timeSlots.forEach((slot: any, idx: number) => {
                    console.log(`📅 [UPDATE] New slot ${idx}: id=${slot.id}, enabled=${slot.enabled}, start=${slot.startMinutes}, stop=${slot.stopMinutes}`);
                });
            }
        }

        // Désactiver le schedule récurrent si présent (le schedule calendrier prend la priorité)
        try {
            await disableRecurringScheduleForAd(userId, adId);
            await createLog(userId, "RECURRING_SCHEDULE_DISABLED", {
                adId,
                reason: "Calendar schedule updated"
            });
        } catch (deleteError) {
            console.error('⚠️ Error disabling recurring schedule:', deleteError);
            // Ne pas faire échouer l'opération principale si la désactivation échoue
        }

        // Merger les nouveaux schedules avec les existants AU NIVEAU DES SLOTS (pas des dates)
        // Cela préserve les slots existants qui ne sont pas modifiés
        const mergedSchedules = { ...existing.schedules };

        // Valider et merger les nouveaux schedules
        for (const [date, daySchedule] of Object.entries(schedules)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid date format: ${date}`
                });
            }

            const day = daySchedule as DaySchedule;
            if (!day.timeSlots || !Array.isArray(day.timeSlots)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid timeSlots for date ${date}`
                });
            }

            // Récupérer les slots existants pour cette date (si elle existe)
            const existingDaySchedule = mergedSchedules[date];
            const existingSlots = existingDaySchedule?.timeSlots || [];

            // Valider et préparer les nouveaux slots
            const validatedSlots: TimeSlot[] = [];
            for (const slot of day.timeSlots) {
                if (slot.startMinutes < 0 || slot.startMinutes > 1439 ||
                    slot.stopMinutes < 0 || slot.stopMinutes > 1439 ||
                    slot.startMinutes >= slot.stopMinutes) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid time slot for date ${date}`
                    });
                }

                // Vérifier que la durée du slot est d'au moins 1 heure (60 minutes)
                const slotDuration = slot.stopMinutes - slot.startMinutes;
                if (slotDuration < 60) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid time slot for date ${date}: Each time slot must have a minimum duration of 1 hour (60 minutes). The slot from ${formatMinutesToTime(slot.startMinutes)} to ${formatMinutesToTime(slot.stopMinutes)} is only ${slotDuration} minutes.`
                    });
                }

                // Générer ID si manquant
                if (!slot.id) {
                    slot.id = `${date}-${slot.startMinutes}-${slot.stopMinutes}-${Date.now()}`;
                }

                // Préserver enabled si non défini (garder la valeur existante ou true par défaut)
                if (slot.enabled === undefined) {
                    // Chercher le slot existant avec le même ID pour préserver son état enabled
                    const existingSlot = existingSlots.find(s => s.id === slot.id);
                    slot.enabled = existingSlot?.enabled !== undefined ? existingSlot.enabled : true;
                }

                validatedSlots.push(slot);
            }

            // MERGER les slots par ID : remplacer les slots existants avec le même ID, ajouter les nouveaux
            const mergedSlots: TimeSlot[] = [...existingSlots];

            for (const newSlot of validatedSlots) {
                const existingSlotIndex = mergedSlots.findIndex(s => s.id === newSlot.id);
                if (existingSlotIndex >= 0) {
                    // Slot existant : remplacer en préservant enabled si non fourni
                    if (newSlot.enabled === undefined && mergedSlots[existingSlotIndex].enabled !== undefined) {
                        newSlot.enabled = mergedSlots[existingSlotIndex].enabled;
                    }
                    mergedSlots[existingSlotIndex] = newSlot;
                } else {
                    // Nouveau slot : ajouter
                    mergedSlots.push(newSlot);
                }
            }

            // Mettre à jour la date avec les slots mergés
            mergedSchedules[date] = {
                timeSlots: mergedSlots
            };

            // Valider les règles de slots après le merge (max 2 par jour, min 1h entre activation/stop)
            const validation = validateDaySlots(date, mergedSlots);
            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    message: validation.message
                });
            }

            console.log(`📅 [UPDATE] After merge for ${date}: ${mergedSlots.length} slots total`);
            mergedSlots.forEach((slot: any, idx: number) => {
                console.log(`📅 [UPDATE] Merged slot ${idx}: id=${slot.id}, enabled=${slot.enabled}, start=${slot.startMinutes}, stop=${slot.stopMinutes}`);
            });
        }

        // Mettre à jour en DB (requête optimisée avec index)
        const { data, error } = await supabase
            .from('calendar_schedules')
            .update({
                schedule_data: mergedSchedules,
                timezone: timezone || existing.timezone,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .select()
            .single();

        if (error) {
            console.error('❌ Error updating calendar schedule:', error);
            return res.status(500).json({
                success: false,
                message: "Error updating calendar schedule",
                error: error.message
            });
        }

        // Invalider le cache
        invalidateCalendarCache(userId, adId);

        // Log
        await createLog(userId, "CALENDAR_SCHEDULE_UPDATE", {
            adId,
            updatedDays: Object.keys(schedules).length,
            totalDays: Object.keys(mergedSchedules).length
        });

        return res.json({
            success: true,
            message: "Calendar schedule updated successfully",
            data: {
                id: data.id,
                adId: data.ad_id,
                totalDays: Object.keys(mergedSchedules).length
            }
        });

    } catch (error: any) {
        console.error('❌ Error updating calendar schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error updating calendar schedule"
        });
    }
}

// DELETE /api/schedules/calendar/:adId/date/:date - Supprimer le schedule d'une date spécifique
export async function deleteCalendarScheduleDate(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId, date } = req.params;

        console.log(`📅 Deleting calendar schedule date ${date} for ad ${adId}`);

        // Valider format de date
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({
                success: false,
                message: "Invalid date format. Expected YYYY-MM-DD"
            });
        }

        // Charger le schedule existant
        const existing = await getCalendarScheduleFromCacheOrDB(userId, adId);

        if (!existing || !existing.schedules[date]) {
            return res.status(404).json({
                success: false,
                message: `No schedule found for date ${date}`
            });
        }

        // Supprimer la date du schedule
        const updatedSchedules = { ...existing.schedules };
        delete updatedSchedules[date];

        // Mettre à jour en DB (requête optimisée)
        const { data, error } = await supabase
            .from('calendar_schedules')
            .update({
                schedule_data: updatedSchedules,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .select()
            .single();

        if (error) {
            console.error('❌ Error deleting calendar schedule date:', error);
            return res.status(500).json({
                success: false,
                message: "Error deleting calendar schedule date",
                error: error.message
            });
        }

        // Invalider le cache
        invalidateCalendarCache(userId, adId);

        return res.json({
            success: true,
            message: `Schedule for date ${date} deleted successfully`,
            data: {
                deletedDate: date,
                remainingDays: Object.keys(updatedSchedules).length
            }
        });

    } catch (error: any) {
        console.error('❌ Error deleting calendar schedule date:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error deleting calendar schedule date"
        });
    }
}

// DELETE /api/schedules/calendar/:adId - Supprimer complètement le schedule calendrier
export async function deleteCalendarSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;

        console.log(`📅 Deleting calendar schedule for ad ${adId}`);

        // Supprimer de la DB (requête optimisée avec index)
        const { error } = await supabase
            .from('calendar_schedules')
            .delete()
            .eq('user_id', userId)
            .eq('ad_id', adId);

        if (error) {
            console.error('❌ Error deleting calendar schedule:', error);
            return res.status(500).json({
                success: false,
                message: "Error deleting calendar schedule",
                error: error.message
            });
        }

        // Invalider le cache
        invalidateCalendarCache(userId, adId);

        // Log
        await createLog(userId, "CALENDAR_SCHEDULE_DELETE", {
            adId
        });

        return res.json({
            success: true,
            message: "Calendar schedule deleted successfully"
        });

    } catch (error: any) {
        console.error('❌ Error deleting calendar schedule:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error deleting calendar schedule"
        });
    }
}

// GET /api/schedules/calendar/:adId/history - Récupérer l'historique des exécutions
export async function getCalendarScheduleHistory(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;

        // Paramètres de requête avec valeurs par défaut
        const dateFrom = req.query.dateFrom as string | undefined;
        const dateTo = req.query.dateTo as string | undefined;
        const executionTimeFrom = req.query.executionTimeFrom as string | undefined;
        const executionTimeTo = req.query.executionTimeTo as string | undefined;
        const action = req.query.action as 'ACTIVE' | 'STOP' | undefined;
        const status = req.query.status as 'SUCCESS' | 'ERROR' | 'PENDING' | undefined;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        console.log(`📜 Getting calendar schedule history for ad ${adId}`);

        // Construire la requête avec filtres
        let query = supabase
            .from('calendar_schedule_history')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .order('execution_time', { ascending: false })
            .range(offset, offset + limit - 1);

        // Appliquer les filtres optionnels
        // Filtre par execution_time (plus précis, inclut l'heure)
        if (executionTimeFrom) {
            query = query.gte('execution_time', executionTimeFrom);
        }
        if (executionTimeTo) {
            query = query.lte('execution_time', executionTimeTo);
        }
        // Filtre par schedule_date (si execution_time n'est pas fourni)
        if (!executionTimeFrom && dateFrom) {
            query = query.gte('schedule_date', dateFrom);
        }
        if (!executionTimeTo && dateTo) {
            query = query.lte('schedule_date', dateTo);
        }
        if (action) {
            query = query.eq('action', action);
        }
        if (status) {
            query = query.eq('status', status);
        }

        const { data, error, count } = await query;

        if (error) {
            console.error('❌ Error getting calendar schedule history:', error);
            return res.status(500).json({
                success: false,
                message: error.message || "Error getting calendar schedule history"
            });
        }

        // Transformer les données pour le frontend
        const history = (data || []).map(item => ({
            id: item.id,
            scheduleDate: item.schedule_date,
            slotId: item.slot_id,
            startMinutes: item.start_minutes,
            stopMinutes: item.stop_minutes,
            action: item.action,
            status: item.status,
            executionTime: item.execution_time,
            timezone: item.timezone,
            errorMessage: item.error_message || undefined,
            facebookApiResponse: item.facebook_api_response || undefined
        }));

        return res.json({
            success: true,
            data: {
                history,
                total: count || 0,
                limit,
                offset
            }
        });

    } catch (error: any) {
        console.error('❌ Error getting calendar schedule history:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error getting calendar schedule history"
        });
    }
}

// DELETE /api/schedules/calendar/:adId/history - Supprimer des entrées d'historique
export async function deleteCalendarScheduleHistory(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { ids } = req.body; // Array of history entry IDs to delete

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "IDs array is required and must not be empty"
            });
        }

        console.log(`🗑️ Deleting ${ids.length} calendar schedule history entry/entries for ad ${adId}`);

        // Supprimer les entrées d'historique (vérifier que l'utilisateur est propriétaire)
        const { error } = await supabase
            .from('calendar_schedule_history')
            .delete()
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .in('id', ids);

        if (error) {
            console.error('❌ Error deleting calendar schedule history:', error);
            return res.status(500).json({
                success: false,
                message: error.message || "Error deleting calendar schedule history"
            });
        }

        console.log(`✅ Successfully deleted ${ids.length} history entry/entries`);

        return res.json({
            success: true,
            message: `Successfully deleted ${ids.length} history entry/entries`,
            deletedCount: ids.length
        });

    } catch (error: any) {
        console.error('❌ Error deleting calendar schedule history:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Error deleting calendar schedule history"
        });
    }
}

