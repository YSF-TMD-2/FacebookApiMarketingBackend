import { Request, Response } from "../types/express.js";
import { getFacebookToken, fetchFbGraph } from "./facebookController.js";
import { createLog } from "../services/loggerService.js";
import { supabase } from "../supabaseClient.js";
import axios from "axios";

// Exporter les interfaces pour utilisation dans calendarScheduleController
export type { CalendarScheduleData, TimeSlot, DaySchedule };

// Interface pour les données de schedule
interface ScheduleData {
    adId: string;
    scheduleType: 'START' | 'STOP' | 'PAUSE' | 'RECURRING_DAILY' | 'CALENDAR_SCHEDULE';
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

// Interface pour les créneaux horaires dans un schedule calendrier
interface TimeSlot {
    id: string;              // UUID pour identification unique
    startMinutes: number;    // Heure d'activation (0-1439)
    stopMinutes: number;     // Heure d'arrêt (0-1439)
    enabled?: boolean;       // Permet de désactiver temporairement (défaut: true)
}

// Interface pour le schedule d'un jour spécifique
interface DaySchedule {
    timeSlots: TimeSlot[];
}

// Interface pour les données de schedule calendrier
interface CalendarScheduleData {
    adId: string;
    scheduleType: 'CALENDAR_SCHEDULE';
    timezone: string;
    schedules: {
        [date: string]: DaySchedule;  // Format: "YYYY-MM-DD"
    };
    lastExecutedDate?: string;        // Format: "YYYY-MM-DD"
    lastExecutedSlotId?: string;      // ID du dernier slot exécuté
    lastExecutedAction?: string;       // 'ACTIVE' ou 'STOP'
    createdAt?: string;
    updatedAt?: string;
}

// Stockage temporaire des schedules (cache en mémoire pour performance, mais persistant en DB)
const schedules: Map<string, ScheduleData[]> = new Map();

// Cache pour les schedules calendrier (optimisation pour requêtes fréquentes)
const calendarSchedulesCache: Map<string, CalendarScheduleData> = new Map();
const CALENDAR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const calendarCacheTimestamps: Map<string, number> = new Map();

// Fonction helper pour convertir ScheduleData vers format DB
function scheduleDataToDb(schedule: ScheduleData, userId: string): any {
    return {
        user_id: userId,
        ad_id: schedule.adId,
        schedule_type: schedule.scheduleType,
        scheduled_date: schedule.scheduledDate,
        timezone: schedule.timezone,
        start_minutes: schedule.startMinutes ?? null,
        end_minutes: schedule.endMinutes ?? null,
        stop_minutes_1: schedule.stopMinutes1 ?? null,
        stop_minutes_2: schedule.stopMinutes2 ?? null,
        start_minutes_2: schedule.startMinutes2 ?? null,
        executed_at: schedule.executedAt ?? null,
        last_action: schedule.lastAction ?? null,
        last_execution_date: schedule.lastExecutionDate ?? null,
        updated_at: new Date().toISOString()
    };
}

// Fonction helper pour convertir format DB vers ScheduleData
function dbToScheduleData(dbRow: any): ScheduleData {
    // Convertir null en undefined pour la cohérence
    const toUndefined = (value: any) => value === null ? undefined : value;
    
    return {
        adId: dbRow.ad_id,
        scheduleType: dbRow.schedule_type,
        scheduledDate: dbRow.scheduled_date,
        timezone: dbRow.timezone,
        startMinutes: toUndefined(dbRow.start_minutes),
        endMinutes: toUndefined(dbRow.end_minutes),
        stopMinutes1: toUndefined(dbRow.stop_minutes_1),
        stopMinutes2: toUndefined(dbRow.stop_minutes_2),
        startMinutes2: toUndefined(dbRow.start_minutes_2),
        executedAt: toUndefined(dbRow.executed_at),
        lastAction: toUndefined(dbRow.last_action),
        lastExecutionDate: toUndefined(dbRow.last_execution_date)
    };
}

// Charger tous les schedules depuis la base de données au démarrage
export async function loadSchedulesFromDB() {
    try {
        // console.log(' Loading schedules from database...');
        const { data: dbSchedules, error } = await supabase
            .from('schedules')
            .select('*');
        
        if (error) {
            // console.error(' Error loading schedules from DB:', error);
            // Si la table n'existe pas encore, on continue sans erreur
            if (error.code === 'PGRST116' || error.message?.includes('does not exist')) {
                // console.log(' Schedules table does not exist yet. It will be created on first schedule creation.');
                return;
            }
            throw error;
        }
        
        if (!dbSchedules || dbSchedules.length === 0) {
            // console.log(' No schedules found in database');
            return;
        }
        
        // Grouper par user_id et charger dans la Map
        schedules.clear();
        for (const dbSchedule of dbSchedules) {
            const userId = dbSchedule.user_id;
            if (!schedules.has(userId)) {
                schedules.set(userId, []);
            }
            schedules.get(userId)!.push(dbToScheduleData(dbSchedule));
        }
        
        // console.log(` Loaded ${dbSchedules.length} schedule(s) from database for ${schedules.size} user(s)`);
    } catch (error) {
        // console.error(' Error in loadSchedulesFromDB:', error);
        // Ne pas bloquer le démarrage si le chargement échoue
    }
}

// Exporter les fonctions helper pour utilisation dans calendarScheduleController
export function getCurrentMinutesInTimezone(timezone: string): number {
    try {
        // Créer une date formatter pour le timezone spécifié
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        });
        
        const parts = formatter.formatToParts(now);
        const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
        const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
        
        const totalMinutes = hour * 60 + minute;
        
        // Log pour déboguer la transition de minuit
        if (totalMinutes === 0 || totalMinutes === 1) {
            console.log(` Midnight transition check (timezone: ${timezone}): currentMinutes=${totalMinutes}, hour=${hour}, minute=${minute}, UTC time=${now.toISOString()}`);
        }
        
        return totalMinutes;
    } catch (error) {
        console.error(` Error getting time in timezone ${timezone}, falling back to local time:`, error);
        // Fallback: utiliser l'heure locale du serveur
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
    }
}

// Exporter les fonctions helper pour utilisation dans calendarScheduleController
export function getCurrentDateInTimezone(timezone: string): string {
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-CA', { // 'en-CA' donne le format YYYY-MM-DD
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        
        const dateStr = formatter.format(now);
        
        // Log pour déboguer la transition de minuit et le changement de jour
        // Vérifier l'heure directement sans appeler getCurrentMinutesInTimezone pour éviter la récursion
        const timeFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        });
        const timeParts = timeFormatter.formatToParts(now);
        const hour = parseInt(timeParts.find(p => p.type === 'hour')?.value || '0', 10);
        const minute = parseInt(timeParts.find(p => p.type === 'minute')?.value || '0', 10);
        const currentMinutes = hour * 60 + minute;
        
        if (currentMinutes === 0 || currentMinutes === 1) {
            console.log(`Date check at midnight (timezone: ${timezone}): currentDate=${dateStr}, currentMinutes=${currentMinutes}, UTC time=${now.toISOString()}`);
        }
        
        return dateStr;
    } catch (error) {
        console.error(` Error getting date in timezone ${timezone}, falling back to UTC:`, error);
        // Fallback: utiliser la date UTC
        const now = new Date();
        return now.toISOString().split('T')[0];
    }
}

// Exporter les fonctions helper pour utilisation dans calendarScheduleController
export function isTimeMatch(currentMinutes: number, targetMinutes: number, windowMinutes: number = 5): boolean {
    // Normaliser les minutes (0-1439)
    const normalizedCurrent = currentMinutes % 1440;
    const normalizedTarget = targetMinutes % 1440;
    
    // Gérer le cas spécial de minuit (00:00)
    if (normalizedTarget === 0) {
        // Pour minuit, vérifier dans une fenêtre autour de 0 (23:55-00:05)
        return normalizedCurrent >= (1440 - windowMinutes) || normalizedCurrent < windowMinutes;
    }
    
    // Vérifier dans une fenêtre autour de l'heure cible
    const lowerBound = normalizedTarget - windowMinutes;
    const upperBound = normalizedTarget + windowMinutes;
    
    // Gérer le cas où la fenêtre dépasse minuit (ex: target = 1, window = 5 → 23:56-00:06)
    if (lowerBound < 0) {
        return normalizedCurrent >= (1440 + lowerBound) || normalizedCurrent <= upperBound;
    }
    
    // Gérer le cas où la fenêtre dépasse 24h (ex: target = 1435, window = 5 → 23:30-00:00)
    if (upperBound >= 1440) {
        return normalizedCurrent >= lowerBound || normalizedCurrent <= (upperBound - 1440);
    }
    
    // Cas normal : fenêtre complètement dans la journée
    return normalizedCurrent >= lowerBound && normalizedCurrent <= upperBound;
}

// Fonction pour vérifier si un schedule doit être exécuté
function checkIfScheduleShouldExecute(schedule: ScheduleData, now: Date): { shouldExecute: boolean; action?: string } {
    const scheduledTime = new Date(schedule.scheduledDate);
    // IMPORTANT: Utiliser le timezone du schedule pour calculer l'heure actuelle
    const currentMinutes = getCurrentMinutesInTimezone(schedule.timezone);
    // Pour la date, on doit aussi utiliser le timezone du schedule
    const currentDateInTimezone = getCurrentDateInTimezone(schedule.timezone); // Format: YYYY-MM-DD
    
    // Log détaillé pour la transition de minuit (00h00 → 00h01)
    const isMidnightTransition = currentMinutes === 0 || currentMinutes === 1;
    if (isMidnightTransition) {
        const dateChanged = schedule.lastExecutionDate !== currentDateInTimezone;
        console.log(` MIDNIGHT TRANSITION DETECTED for ad ${schedule.adId} (timezone: ${schedule.timezone}):`, {
            currentMinutes,
            currentDate: currentDateInTimezone,
            lastExecutionDate: schedule.lastExecutionDate,
            lastAction: schedule.lastAction,
            dateChanged,
            UTC_time: new Date().toISOString()
        });
        if (dateChanged) {
            console.log(`🔄 DATE CHANGED at midnight! New day detected: ${currentDateInTimezone}`);
        }
    }
    
    console.log(`🔍 Checking schedule for ad ${schedule.adId} (timezone: ${schedule.timezone}):`, {
        scheduleType: schedule.scheduleType,
        currentMinutes,
        currentDate: currentDateInTimezone,
        lastExecutionDate: schedule.lastExecutionDate,
        lastAction: schedule.lastAction
    });
    
    // Gérer RECURRING_DAILY avec 2 ou 4 actions
    if (schedule.scheduleType === 'RECURRING_DAILY') {
        const has4Actions = schedule.stopMinutes1 !== undefined && 
                           schedule.startMinutes !== undefined && 
                           schedule.stopMinutes2 !== undefined && 
                           schedule.startMinutes2 !== undefined;
        
        const has2Actions = schedule.stopMinutes1 !== undefined && 
                           schedule.startMinutes !== undefined &&
                           schedule.stopMinutes2 === undefined && 
                           schedule.startMinutes2 === undefined;
        
        console.log(`🔍 Schedule type detection for ad ${schedule.adId}:`, {
            has4Actions,
            has2Actions,
            stopMinutes1: schedule.stopMinutes1,
            startMinutes: schedule.startMinutes,
            stopMinutes2: schedule.stopMinutes2,
            startMinutes2: schedule.startMinutes2
        });
        
        if (has4Actions) {
            // Gérer RECURRING_DAILY avec 4 actions
            // Cycle: STOP_1 → ACTIVE_1 → STOP_2 → ACTIVE_2 → STOP_1 (jour suivant) ...
            
            // Vérifier si on a déjà exécuté une action aujourd'hui
            if (schedule.lastExecutionDate === currentDateInTimezone && schedule.lastAction) {
                console.log(`⏰ Already executed ${schedule.lastAction} today for ad ${schedule.adId}`);
                console.log(`🔍 4-actions schedule check: currentMinutes=${currentMinutes}, stopMinutes1=${schedule.stopMinutes1}, startMinutes=${schedule.startMinutes}, stopMinutes2=${schedule.stopMinutes2}, startMinutes2=${schedule.startMinutes2}`);
                
                // Déterminer quelle est la prochaine action à exécuter selon la dernière action
                if (schedule.lastAction === 'STOP_1') {
                    // Après STOP_1, on doit exécuter ACTIVE_1
                    if (isTimeMatch(currentMinutes, schedule.startMinutes!)) {
                        console.log(`🟢 Time for ACTIVE_1 at ${currentMinutes} (target: ${schedule.startMinutes})`);
                        return { shouldExecute: true, action: 'ACTIVE_1' };
                    } else if (currentMinutes >= schedule.startMinutes!) {
                        // Si on a dépassé l'heure d'ACTIVE_1, l'exécuter quand même (rattrapage)
                        console.log(`🟢 Executing ACTIVE_1 (catch-up) at ${currentMinutes} (target was: ${schedule.startMinutes})`);
                        return { shouldExecute: true, action: 'ACTIVE_1' };
                    } else {
                        const nextActionTime = `${Math.floor(schedule.startMinutes! / 60)}:${(schedule.startMinutes! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Waiting for ACTIVE_1 at ${nextActionTime} (current: ${currentMinutes}, target: ${schedule.startMinutes})`);
                    }
                } else if (schedule.lastAction === 'ACTIVE_1') {
                    // Après ACTIVE_1, on doit exécuter STOP_2
                    if (isTimeMatch(currentMinutes, schedule.stopMinutes2!)) {
                        console.log(`🔴 Time for STOP_2 at ${currentMinutes} (target: ${schedule.stopMinutes2})`);
                        return { shouldExecute: true, action: 'STOP_2' };
                    } else if (currentMinutes >= schedule.stopMinutes2!) {
                        // Si on a dépassé l'heure de STOP_2, l'exécuter quand même (rattrapage)
                        console.log(`🔴 Executing STOP_2 (catch-up) at ${currentMinutes} (target was: ${schedule.stopMinutes2})`);
                        return { shouldExecute: true, action: 'STOP_2' };
                    } else {
                        const nextActionTime = `${Math.floor(schedule.stopMinutes2! / 60)}:${(schedule.stopMinutes2! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Waiting for STOP_2 at ${nextActionTime} (current: ${currentMinutes}, target: ${schedule.stopMinutes2})`);
                    }
                } else if (schedule.lastAction === 'STOP_2') {
                    // Après STOP_2, on doit exécuter ACTIVE_2
                    if (isTimeMatch(currentMinutes, schedule.startMinutes2!)) {
                        console.log(`🟢 Time for ACTIVE_2 at ${currentMinutes} (target: ${schedule.startMinutes2})`);
                        return { shouldExecute: true, action: 'ACTIVE_2' };
                    } else if (currentMinutes >= schedule.startMinutes2!) {
                        // Si on a dépassé l'heure d'ACTIVE_2, l'exécuter quand même (rattrapage)
                        console.log(`🟢 Executing ACTIVE_2 (catch-up) at ${currentMinutes} (target was: ${schedule.startMinutes2})`);
                        return { shouldExecute: true, action: 'ACTIVE_2' };
                    } else {
                        const nextActionTime = `${Math.floor(schedule.startMinutes2! / 60)}:${(schedule.startMinutes2! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Waiting for ACTIVE_2 at ${nextActionTime} (current: ${currentMinutes}, target: ${schedule.startMinutes2})`);
                    }
                } else if (schedule.lastAction === 'ACTIVE_2') {
                    // Après ACTIVE_2, on attend normalement STOP_1 le jour suivant
                    // MAIS vérifier d'abord si on est dans la fenêtre de STOP_1 aujourd'hui
                    // Cela peut arriver si STOP_1 a été sauté au début de la journée
                    // OU si c'est un nouveau jour (la date a changé)
                    if (schedule.lastExecutionDate !== currentDateInTimezone) {
                        console.log(`🔄 Day changed! lastExecutionDate=${schedule.lastExecutionDate}, currentDate=${currentDateInTimezone} - Cycle resets, checking for STOP_1`);
                        // C'est un nouveau jour, vérifier si on est à l'heure de STOP_1
                        // Pour minuit (stopMinutes1 = 0), accepter une fenêtre plus large (0-5 minutes)
                        if (isTimeMatch(currentMinutes, schedule.stopMinutes1!)) {
                            console.log(`🔴 Time for STOP_1 (new day cycle start) at ${currentMinutes}`);
                            return { shouldExecute: true, action: 'STOP_1' };
                        }
                        // Si STOP_1 est à minuit et qu'on est dans les premières minutes du nouveau jour, exécuter quand même
                        if (schedule.stopMinutes1 === 0 && currentMinutes < 5) {
                            console.log(`🔴 Executing STOP_1 at midnight (new day detected, currentMinutes=${currentMinutes})`);
                            return { shouldExecute: true, action: 'STOP_1' };
                        }
                    }
                    const isStop1Time = isTimeMatch(currentMinutes, schedule.stopMinutes1!);
                    console.log(`🔍 Checking STOP_1 recovery: currentMinutes=${currentMinutes}, stopMinutes1=${schedule.stopMinutes1}, isTimeMatch=${isStop1Time}`);
                    if (isStop1Time) {
                        // On est exactement à l'heure de STOP_1, l'exécuter même si ACTIVE_2 a déjà été exécuté
                        // Cela signifie qu'on a peut-être sauté STOP_1 au début de la journée
                        console.log(`🔴 Executing STOP_1 (recovery) at ${currentMinutes} - missed at start of day`);
                        return { shouldExecute: true, action: 'STOP_1' };
                    }
                    // Vérifier si on est dans une fenêtre où on devrait exécuter STOP_2 ou ACTIVE_2
                    // Cela peut arriver si ACTIVE_2 a été exécuté par erreur avant STOP_2
                    if (currentMinutes >= schedule.stopMinutes2! && currentMinutes <= schedule.startMinutes2! + 5) {
                        // On est dans la fenêtre de STOP_2 ou ACTIVE_2, mais ACTIVE_2 a déjà été exécuté
                        // Cela signifie qu'on a peut-être sauté STOP_2 ou exécuté ACTIVE_2 trop tôt
                        // Si on est exactement à l'heure de STOP_2, l'exécuter quand même
                        if (isTimeMatch(currentMinutes, schedule.stopMinutes2!)) {
                            console.log(`🔴 Executing STOP_2 (recovery) at ${currentMinutes} - ACTIVE_2 was executed too early`);
                            return { shouldExecute: true, action: 'STOP_2' };
                        } else if (currentMinutes >= schedule.stopMinutes2! && currentMinutes < schedule.startMinutes2!) {
                            // On est entre STOP_2 et ACTIVE_2, mais ACTIVE_2 a déjà été exécuté
                            // On ne peut pas revenir en arrière, mais on peut loguer l'incohérence
                            console.log(`⚠️ Inconsistent state: ACTIVE_2 already executed but current time (${currentMinutes}) is between STOP_2 (${schedule.stopMinutes2}) and ACTIVE_2 (${schedule.startMinutes2})`);
                        }
                    }
                    const nextActionTime = `${Math.floor(schedule.stopMinutes1! / 60)}:${(schedule.stopMinutes1! % 60).toString().padStart(2, '0')}`;
                    console.log(`⏳ Already executed ACTIVE_2 today, waiting for STOP_1 tomorrow at ${nextActionTime} (current: ${currentMinutes})`);
                }
            } else if (schedule.lastExecutionDate !== currentDateInTimezone || !schedule.lastAction) {
                // Nouveau jour ou première exécution - vérifier quelle action doit être exécutée
                // L'ordre logique est: STOP_1 → ACTIVE_1 → STOP_2 → ACTIVE_2
                console.log(`🔄 NEW DAY DETECTED for ad ${schedule.adId}: lastExecutionDate=${schedule.lastExecutionDate}, currentDate=${currentDateInTimezone}, lastAction=${schedule.lastAction}`);
                console.log(`🔄 Resetting cycle - will start from STOP_1`);
                
                // Si on est dans la fenêtre pour STOP_1, exécuter STOP_1
                if (isTimeMatch(currentMinutes, schedule.stopMinutes1!)) {
                    console.log(`🔴 Time for STOP_1 (new day/first execution) at ${currentMinutes} (target: ${schedule.stopMinutes1})`);
                    return { shouldExecute: true, action: 'STOP_1' };
                }
                // Si STOP_1 est à minuit (0) et qu'on est dans les premières minutes du nouveau jour, exécuter quand même
                if (schedule.stopMinutes1 === 0 && currentMinutes < 5) {
                    console.log(`🔴 Executing STOP_1 at midnight (new day/first execution, currentMinutes=${currentMinutes})`);
                    return { shouldExecute: true, action: 'STOP_1' };
                }
                // Si on est dans la fenêtre pour ACTIVE_1, exécuter ACTIVE_1
                else if (isTimeMatch(currentMinutes, schedule.startMinutes!)) {
                    console.log(`🟢 Time for ACTIVE_1 (new day/first execution) at ${currentMinutes} (target: ${schedule.startMinutes})`);
                    return { shouldExecute: true, action: 'ACTIVE_1' };
                }
                // Si ACTIVE_1 est à minuit (0) et qu'on est dans les premières minutes du nouveau jour, exécuter quand même
                else if (schedule.startMinutes === 0 && currentMinutes < 5) {
                    console.log(`🟢 Executing ACTIVE_1 at midnight (new day/first execution, currentMinutes=${currentMinutes})`);
                    return { shouldExecute: true, action: 'ACTIVE_1' };
                }
                // Si on est dans la fenêtre pour STOP_2, exécuter STOP_2
                else if (isTimeMatch(currentMinutes, schedule.stopMinutes2!)) {
                    console.log(`🔴 Time for STOP_2 (new day/first execution) at ${currentMinutes} (target: ${schedule.stopMinutes2})`);
                    return { shouldExecute: true, action: 'STOP_2' };
                }
                // Si on est dans la fenêtre pour ACTIVE_2, exécuter ACTIVE_2
                else if (isTimeMatch(currentMinutes, schedule.startMinutes2!)) {
                    console.log(`🟢 Time for ACTIVE_2 (new day/first execution) at ${currentMinutes} (target: ${schedule.startMinutes2})`);
                    return { shouldExecute: true, action: 'ACTIVE_2' };
                }
                // Sinon, déterminer quelle est la prochaine action selon l'heure actuelle
                else {
                    // Si on est entre STOP_1 et ACTIVE_1, attendre ACTIVE_1
                    if (currentMinutes > schedule.stopMinutes1! && currentMinutes < schedule.startMinutes!) {
                        const nextActionTime = `${Math.floor(schedule.startMinutes! / 60)}:${(schedule.startMinutes! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Between STOP_1 and ACTIVE_1, waiting for ACTIVE_1 at ${nextActionTime} (current: ${currentMinutes})`);
                    }
                    // Si on est entre ACTIVE_1 et STOP_2, attendre STOP_2
                    else if (currentMinutes > schedule.startMinutes! && currentMinutes < schedule.stopMinutes2!) {
                        const nextActionTime = `${Math.floor(schedule.stopMinutes2! / 60)}:${(schedule.stopMinutes2! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Between ACTIVE_1 and STOP_2, waiting for STOP_2 at ${nextActionTime} (current: ${currentMinutes})`);
                    }
                    // Si on est entre STOP_2 et ACTIVE_2, attendre ACTIVE_2
                    else if (currentMinutes > schedule.stopMinutes2! && currentMinutes < schedule.startMinutes2!) {
                        const nextActionTime = `${Math.floor(schedule.startMinutes2! / 60)}:${(schedule.startMinutes2! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Between STOP_2 and ACTIVE_2, waiting for ACTIVE_2 at ${nextActionTime} (current: ${currentMinutes})`);
                    }
                    // Si on est après ACTIVE_2, attendre STOP_1 le jour suivant
                    else if (currentMinutes > schedule.startMinutes2!) {
                        const nextActionTime = `${Math.floor(schedule.stopMinutes1! / 60)}:${(schedule.stopMinutes1! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ After ACTIVE_2 today, waiting for STOP_1 tomorrow at ${nextActionTime} (current: ${currentMinutes})`);
                    }
                    // Si on est avant STOP_1, attendre STOP_1
                    else {
                        const nextActionTime = `${Math.floor(schedule.stopMinutes1! / 60)}:${(schedule.stopMinutes1! % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Before STOP_1, waiting for STOP_1 at ${nextActionTime} (current: ${currentMinutes})`);
                    }
                }
            }
        } else if (has2Actions) {
            // Gérer RECURRING_DAILY avec seulement 2 actions (STOP_1 et ACTIVE_1)
            // Cycle: STOP_1 (jour N) → ACTIVE_1 (jour N) → STOP_1 (jour N+1) → ACTIVE_1 (jour N+1) ...
            
            const stop1Minutes = schedule.stopMinutes1!;
            const active1Minutes = schedule.startMinutes!;
            
            if (schedule.lastExecutionDate === currentDateInTimezone && schedule.lastAction) {
                // On a déjà exécuté une action aujourd'hui
                console.log(`⏰ Already executed ${schedule.lastAction} today for ad ${schedule.adId}`);
                
                if (schedule.lastAction === 'STOP_1') {
                    // On a exécuté STOP_1 aujourd'hui, vérifier si c'est l'heure pour ACTIVE_1
                    if (isTimeMatch(currentMinutes, active1Minutes)) {
                        console.log(`🟢 Time for ACTIVE_1 at ${currentMinutes} (target: ${active1Minutes})`);
                        return { shouldExecute: true, action: 'ACTIVE_1' };
                    } else if (currentMinutes >= active1Minutes) {
                        // Si on a dépassé l'heure d'ACTIVE_1, l'exécuter quand même (rattrapage)
                        console.log(`🟢 Executing ACTIVE_1 (catch-up) at ${currentMinutes} (target was: ${active1Minutes})`);
                        return { shouldExecute: true, action: 'ACTIVE_1' };
                    } else {
                        // On attend ACTIVE_1, mais ce n'est pas encore l'heure
                        const nextActionTime = `${Math.floor(active1Minutes / 60)}:${(active1Minutes % 60).toString().padStart(2, '0')}`;
                        console.log(`⏳ Waiting for ACTIVE_1 at ${nextActionTime} (current: ${currentMinutes}, target: ${active1Minutes})`);
                    }
                } else if (schedule.lastAction === 'ACTIVE_1') {
                    // On a exécuté ACTIVE_1 aujourd'hui, normalement on attend STOP_1 le jour suivant
                    // MAIS vérifier d'abord si c'est un nouveau jour (la date a changé)
                    // OU si on est dans la fenêtre de STOP_1 aujourd'hui
                    if (schedule.lastExecutionDate !== currentDateInTimezone) {
                        console.log(`🔄 Day changed! lastExecutionDate=${schedule.lastExecutionDate}, currentDate=${currentDateInTimezone} - Cycle resets, checking for STOP_1`);
                        // C'est un nouveau jour, vérifier si on est à l'heure de STOP_1
                        if (isTimeMatch(currentMinutes, stop1Minutes)) {
                            console.log(`🔴 Time for STOP_1 (new day cycle start) at ${currentMinutes}`);
                            return { shouldExecute: true, action: 'STOP_1' };
                        }
                        // Si STOP_1 est à minuit et qu'on est dans les premières minutes du nouveau jour, exécuter quand même
                        if (stop1Minutes === 0 && currentMinutes < 5) {
                            console.log(`🔴 Executing STOP_1 at midnight (new day detected, currentMinutes=${currentMinutes})`);
                            return { shouldExecute: true, action: 'STOP_1' };
                        }
                    }
                    const isStop1Time = isTimeMatch(currentMinutes, stop1Minutes);
                    console.log(`🔍 Checking STOP_1 recovery (2-actions): currentMinutes=${currentMinutes}, stop1Minutes=${stop1Minutes}, isTimeMatch=${isStop1Time}`);
                    if (isStop1Time) {
                        // On est exactement à l'heure de STOP_1, l'exécuter même si ACTIVE_1 a déjà été exécuté
                        // Cela signifie qu'on a peut-être sauté STOP_1 au début de la journée
                        console.log(`🔴 Executing STOP_1 (recovery) at ${currentMinutes} - missed at start of day`);
                        return { shouldExecute: true, action: 'STOP_1' };
                    }
                    // Sinon, attendre STOP_1 le jour suivant
                    const nextActionTime = `${Math.floor(stop1Minutes / 60)}:${(stop1Minutes % 60).toString().padStart(2, '0')}`;
                    console.log(`⏳ Already executed ACTIVE_1 today, waiting for STOP_1 tomorrow at ${nextActionTime} (current: ${currentMinutes})`);
                }
            } else {
                // Nouveau jour ou première exécution - déterminer quelle action doit être exécutée
                // Logique : si on est entre STOP_1 et ACTIVE_1, on attend ACTIVE_1
                // Si on est après ACTIVE_1, on attend STOP_1 le jour suivant
                console.log(`🔄 NEW DAY DETECTED (2-actions) for ad ${schedule.adId}: lastExecutionDate=${schedule.lastExecutionDate}, currentDate=${currentDateInTimezone}, lastAction=${schedule.lastAction}`);
                console.log(`🔄 Resetting cycle - will start from STOP_1`);
                
                // Vérifier si on est dans la fenêtre pour STOP_1
                if (isTimeMatch(currentMinutes, stop1Minutes)) {
                    console.log(`🔴 Time for STOP_1 (new day/first execution) at ${currentMinutes} (target: ${stop1Minutes})`);
                    return { shouldExecute: true, action: 'STOP_1' };
                }
                // Si STOP_1 est à minuit (0) et qu'on est dans les premières minutes du nouveau jour, exécuter quand même
                if (stop1Minutes === 0 && currentMinutes < 5) {
                    console.log(`🔴 Executing STOP_1 at midnight (new day/first execution, currentMinutes=${currentMinutes})`);
                    return { shouldExecute: true, action: 'STOP_1' };
                }
                // Vérifier si on est dans la fenêtre pour ACTIVE_1
                else if (isTimeMatch(currentMinutes, active1Minutes)) {
                    console.log(`🟢 Time for ACTIVE_1 (new day/first execution) at ${currentMinutes} (target: ${active1Minutes})`);
                    return { shouldExecute: true, action: 'ACTIVE_1' };
                }
                // Si ACTIVE_1 est à minuit (0) et qu'on est dans les premières minutes du nouveau jour, exécuter quand même
                else if (active1Minutes === 0 && currentMinutes < 5) {
                    console.log(`🟢 Executing ACTIVE_1 at midnight (new day/first execution, currentMinutes=${currentMinutes})`);
                    return { shouldExecute: true, action: 'ACTIVE_1' };
                }
                // Si on est entre STOP_1 et ACTIVE_1, on attend ACTIVE_1
                // Note: pour minuit (stop1Minutes = 0), cette condition peut être problématique
                // car currentMinutes > 0 sera toujours vrai après minuit
                // Mais on a déjà vérifié isTimeMatch ci-dessus, donc si on arrive ici,
                // c'est qu'on n'est pas dans la fenêtre de STOP_1
                else if (currentMinutes > stop1Minutes && currentMinutes < active1Minutes) {
                    const nextActionTime = `${Math.floor(active1Minutes / 60)}:${(active1Minutes % 60).toString().padStart(2, '0')}`;
                    console.log(`⏳ Between STOP_1 and ACTIVE_1, waiting for ACTIVE_1 at ${nextActionTime} (current: ${currentMinutes})`);
                }
                // Si on est après ACTIVE_1, on attend STOP_1 le jour suivant
                // MAIS vérifier d'abord si on est encore dans la fenêtre de STOP_1 (pour le cas où STOP_1 = 0)
                else if (currentMinutes > active1Minutes) {
                    // Si STOP_1 est à minuit (0), vérifier si on est encore dans la fenêtre de récupération
                    if (stop1Minutes === 0 && currentMinutes < 5) {
                        // On est dans la fenêtre de récupération pour minuit (00:00-00:05)
                        console.log(`🔴 Executing STOP_1 (recovery after ACTIVE_1) at ${currentMinutes} - still in midnight window`);
                        return { shouldExecute: true, action: 'STOP_1' };
                    }
                    console.log(`⏳ After ACTIVE_1 today, waiting for STOP_1 tomorrow at ${Math.floor(stop1Minutes / 60)}:${(stop1Minutes % 60).toString().padStart(2, '0')} (current: ${currentMinutes})`);
                }
                // Si on est avant STOP_1, on attend STOP_1
                // Note: pour minuit (stop1Minutes = 0), cette condition ne sera jamais vraie
                // car currentMinutes ne peut pas être < 0
                else {
                    const nextActionTime = `${Math.floor(stop1Minutes / 60)}:${(stop1Minutes % 60).toString().padStart(2, '0')}`;
                    console.log(`⏳ Before STOP_1, waiting for STOP_1 at ${nextActionTime} (current: ${currentMinutes})`);
                }
            }
        } else {
            console.log(`⚠️ Invalid RECURRING_DAILY schedule configuration for ad ${schedule.adId}`);
            return { shouldExecute: false };
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

        // Validation spécifique pour RECURRING_DAILY
        if (scheduleType === 'RECURRING_DAILY') {
            // Pour RECURRING_DAILY, on doit avoir au moins stopMinutes1 et startMinutes
            if (stopMinutes1 === undefined || startMinutes === undefined) {
                return res.status(400).json({
                    success: false,
                    message: "RECURRING_DAILY schedule requires at least stopMinutes1 and startMinutes"
                });
            }
            
            // Si on a stopMinutes2 ou startMinutes2, on doit avoir les deux
            const hasPartial4Actions = (stopMinutes2 !== undefined && startMinutes2 === undefined) || 
                                      (stopMinutes2 === undefined && startMinutes2 !== undefined);
            if (hasPartial4Actions) {
                return res.status(400).json({
                    success: false,
                    message: "If you provide stopMinutes2 or startMinutes2, you must provide both for a 4-action schedule"
                });
            }
            
            // Log le type de schedule créé
            if (stopMinutes2 !== undefined && startMinutes2 !== undefined) {
                console.log('📅 Creating RECURRING_DAILY schedule with 4 actions');
            } else {
                console.log('📅 Creating RECURRING_DAILY schedule with 2 actions');
            }
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

        // Si c'est un schedule récurrent, supprimer l'ancien schedule récurrent pour cette ad
        if (scheduleType === 'RECURRING_DAILY') {
            try {
                // Supprimer de la DB
                await supabase
                    .from('schedules')
                    .delete()
                    .eq('user_id', userId)
                    .eq('ad_id', adId)
                    .eq('schedule_type', 'RECURRING_DAILY');
                
                // Supprimer de la mémoire
                const userSchedules = schedules.get(userId) || [];
                const filteredSchedules = userSchedules.filter(s => 
                    !(s.adId === adId && s.scheduleType === 'RECURRING_DAILY')
                );
                schedules.set(userId, filteredSchedules);
                console.log('✅ Removed existing recurring schedule before creating new one');
            } catch (deleteError) {
                console.error('⚠️ Error removing existing recurring schedule:', deleteError);
            }
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

        // Sauvegarder dans la base de données
        try {
            const dbData = scheduleDataToDb(scheduleData, userId);
            const { data: insertedSchedule, error: dbError } = await supabase
                .from('schedules')
                .insert(dbData)
                .select()
                .single();
            
            if (dbError) {
                // Si la table n'existe pas, on continue avec le stockage en mémoire uniquement
                if (dbError.code === 'PGRST116' || dbError.message?.includes('does not exist')) {
                    console.warn('⚠️ Schedules table does not exist. Please create it in Supabase. Using memory-only storage.');
                } else {
                    console.error('❌ Error saving schedule to DB:', dbError);
                    throw dbError;
                }
            } else {
                console.log('✅ Schedule saved to database');
            }
        } catch (dbError: any) {
            console.error('❌ Error persisting schedule to DB:', dbError);
            // Continue même si la DB échoue (fallback en mémoire)
        }

        // Stocker le schedule en mémoire (cache)
        if (!schedules.has(userId)) {
            schedules.set(userId, []);
        }
        schedules.get(userId)!.push(scheduleData);
        console.log('✅ Schedule stored in memory cache');

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



// Exporter les fonctions calendar schedule pour les routes
export { 
    getCalendarSchedule, 
    createCalendarSchedule, 
    updateCalendarSchedule, 
    deleteCalendarScheduleDate, 
    deleteCalendarSchedule 
} from "./calendarScheduleController.js";

// Exécuter les schedules (à appeler périodiquement) - Optimisé pour grandes quantités d'ads
export async function executeSchedules() {
    try {
        const now = new Date();
        let totalSchedules = 0;
        let executedSchedules = 0;
        
        // Si la Map est vide, essayer de charger depuis la DB
        if (schedules.size === 0) {
            await loadSchedulesFromDB();
        }
        
        // Charger TOUS les calendar schedules depuis la DB (on filtre ensuite par dates dans schedule_data)
        // Note: first_date et last_date n'existent pas dans la table, on doit charger tous les schedules
        const { data: fullCalendarSchedules, error: calendarError } = await supabase
            .from('calendar_schedules')
            .select('*')
            .limit(1000); // Limite pour éviter de surcharger
        
        // Créer un Set des adIds qui ont des calendar schedules avec des slots actifs (pour bloquer les schedules récurrents)
        const adsWithCalendarSchedules = new Set<string>();
        
        // Filtrer les calendar schedules qui ont des dates aujourd'hui ou futures dans schedule_data
        const currentDate = new Date().toISOString().split('T')[0];
        const activeCalendarSchedules = fullCalendarSchedules?.filter((schedule: any) => {
            const scheduleData = schedule.schedule_data || {};
            // Vérifier si au moins une date dans schedule_data est >= aujourd'hui
            const dates = Object.keys(scheduleData);
            return dates.some(date => date >= currentDate);
        }) || [];
        
        console.log(`📅 [EXECUTE] Found ${fullCalendarSchedules?.length || 0} total calendar schedules, ${activeCalendarSchedules.length} with dates >= ${currentDate}`);
        
        if (activeCalendarSchedules && activeCalendarSchedules.length > 0) {
            // Traiter les calendar schedules séparément (optimisé)
            // Utiliser activeCalendarSchedules au lieu de fullCalendarSchedules pour ne traiter que ceux qui ont des dates pertinentes
            await executeCalendarSchedules(activeCalendarSchedules, now);
            
            // Vérifier si chaque calendar schedule a vraiment des slots actifs
            for (const calendarSchedule of activeCalendarSchedules) {
                const scheduleData = (calendarSchedule as any).schedule_data || {};
                let hasActiveSlots = false;
                
                // Vérifier si le schedule a des slots actifs (au moins un slot enabled !== false)
                for (const dateKey in scheduleData) {
                    if (scheduleData.hasOwnProperty(dateKey)) {
                        const daySchedule = scheduleData[dateKey];
                        if (daySchedule.timeSlots && daySchedule.timeSlots.length > 0) {
                            const activeSlots = daySchedule.timeSlots.filter((slot: any) => slot.enabled !== false);
                            if (activeSlots.length > 0) {
                                hasActiveSlots = true;
                                break;
                            }
                        }
                    }
                }
                
                // Seulement bloquer si le calendar schedule a vraiment des slots actifs
                if (hasActiveSlots) {
                    const key = `${(calendarSchedule as any).user_id}:${(calendarSchedule as any).ad_id}`;
                    adsWithCalendarSchedules.add(key);
                }
            }
            
            if (adsWithCalendarSchedules.size > 0) {
                console.log(`📅 [EXECUTE] ${adsWithCalendarSchedules.size} calendar schedule(s) with active slots found`);
            }
        }
        
        // Vérifier s'il y a eu une erreur lors du chargement des calendar schedules
        if (calendarError && calendarError.code !== 'PGRST116') {
            console.error('⚠️ Error loading calendar schedules:', calendarError);
        }
        
        // Compter le nombre total de schedules
        for (const userSchedules of schedules.values()) {
            totalSchedules += userSchedules.length;
        }
        
        // Ne logger que s'il y a des schedules actifs
        if (totalSchedules > 0) {
            console.log(`🕐 Checking ${totalSchedules} active schedule(s) at ${now.toISOString()}...`);
        }
        
        for (const [userId, userSchedules] of schedules.entries()) {
            
            for (const schedule of userSchedules) {
                // Ignorer les schedules récurrents si un calendar schedule avec slots actifs existe pour cette ad
                if (schedule.scheduleType === 'RECURRING_DAILY') {
                    const calendarKey = `${userId}:${schedule.adId}`;
                    if (adsWithCalendarSchedules.has(calendarKey)) {
                        // Ne pas logger pour éviter le spam - le schedule est bloqué silencieusement
                        continue; // Ignorer ce schedule récurrent
                    }
                }
                
                // Vérifier si le schedule doit être exécuté maintenant
                const checkResult = checkIfScheduleShouldExecute(schedule, now);
                
                // Log détaillé pour déboguer (seulement si le schedule n'est pas bloqué)
                if (schedule.scheduleType === 'RECURRING_DAILY') {
                    // Utiliser le timezone du schedule pour le logging aussi
                    const currentMinutes = getCurrentMinutesInTimezone(schedule.timezone);
                    const has4Actions = schedule.stopMinutes1 !== undefined && 
                                       schedule.startMinutes !== undefined && 
                                       schedule.stopMinutes2 !== undefined && 
                                       schedule.startMinutes2 !== undefined;
                    console.log(`🔍 Checking schedule for ad ${schedule.adId} (timezone: ${schedule.timezone}):`, {
                        scheduleType: schedule.scheduleType,
                        has4Actions,
                        currentMinutes,
                        stopMinutes1: schedule.stopMinutes1,
                        startMinutes: schedule.startMinutes,
                        stopMinutes2: schedule.stopMinutes2,
                        startMinutes2: schedule.startMinutes2,
                        lastAction: schedule.lastAction,
                        lastExecutionDate: schedule.lastExecutionDate,
                        shouldExecute: checkResult.shouldExecute,
                        action: checkResult.action
                    });
                }
                
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
                        console.log(`📡 Calling Facebook API to update ad ${schedule.adId} status to ${newStatus}...`);
                        
                        // Appeler l'API Facebook pour changer le statut
                        // Facebook Graph API nécessite le token dans l'URL, pas dans le body
                        const response = await fetch(`https://graph.facebook.com/v18.0/${schedule.adId}?access_token=${tokenRow.token}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                status: newStatus
                            })
                        });
                        
                        console.log(`📡 Facebook API response status: ${response.status} ${response.statusText}`);
                        
                        // Lire la réponse (cloner d'abord pour pouvoir la relire si nécessaire)
                        let responseData: any = null;
                        try {
                            const responseText = await response.text();
                            if (responseText) {
                                try {
                                    responseData = JSON.parse(responseText);
                                    console.log(`📡 Facebook API response data:`, responseData);
                                } catch (parseError) {
                                    console.log(`📡 Facebook API response text:`, responseText);
                                    responseData = { rawResponse: responseText };
                                }
                            }
                        } catch (readError) {
                            console.error('⚠️ Error reading Facebook API response:', readError);
                        }
                        
                        // Vérifier si le token est expiré ou si la requête a échoué
                        if (!response.ok) {
                            const errorData = responseData || { error: 'Unknown error', message: 'Failed to parse error response' };
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
                        } else {
                            // Succès
                            console.log(`✅ Schedule executed successfully for ad ${schedule.adId} - Status changed to: ${newStatus}`);
                            if (responseData) {
                                console.log(`✅ Facebook API success response:`, responseData);
                            }
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
                                // Utiliser la date dans le timezone du schedule
                                const currentDateInTimezone = getCurrentDateInTimezone(schedule.timezone);
                                schedule.lastExecutionDate = currentDateInTimezone;
                                schedule.lastAction = actionType;
                                schedule.executedAt = now.toISOString();
                                console.log(`✅ Updated recurring schedule: lastAction=${actionType}, lastExecutionDate=${currentDateInTimezone} (timezone: ${schedule.timezone})`);
                                
                                // Mettre à jour dans la DB
                                try {
                                    await supabase
                                        .from('schedules')
                                        .update({
                                            last_action: actionType,
                                            last_execution_date: currentDateInTimezone,
                                            executed_at: now.toISOString(),
                                            updated_at: now.toISOString()
                                        })
                                        .eq('user_id', userId)
                                        .eq('ad_id', schedule.adId)
                                        .eq('schedule_type', 'RECURRING_DAILY');
                                    console.log('✅ Recurring schedule updated in database');
                                } catch (dbError) {
                                    console.error('⚠️ Error updating recurring schedule in DB:', dbError);
                                }
                            } else if (schedule.startMinutes !== undefined && schedule.endMinutes !== undefined) {
                                // Pour les schedules avec plages horaires (ancien système)
                                console.log('📅 Schedule with time range - keeping for end time execution');
                                schedule.executedAt = now.toISOString();
                                schedule.lastAction = actionType;
                                
                                // Mettre à jour dans la DB
                                try {
                                    await supabase
                                        .from('schedules')
                                        .update({
                                            executed_at: now.toISOString(),
                                            last_action: actionType,
                                            updated_at: now.toISOString()
                                        })
                                        .eq('user_id', userId)
                                        .eq('ad_id', schedule.adId);
                                } catch (dbError) {
                                    console.error('⚠️ Error updating schedule in DB:', dbError);
                                }
                                
                                // Si c'est l'heure de fin, supprimer le schedule
                                if (actionType === 'STOP') {
                                    console.log('📅 Time range completed - removing schedule');
                                    const filteredSchedules = userSchedules.filter(s => s !== schedule);
                                    schedules.set(userId, filteredSchedules);
                                    
                                    // Supprimer de la DB
                                    try {
                                        await supabase
                                            .from('schedules')
                                            .delete()
                                            .eq('user_id', userId)
                                            .eq('ad_id', schedule.adId);
                                        console.log('✅ Schedule removed from database');
                                    } catch (dbError) {
                                        console.error('⚠️ Error removing schedule from DB:', dbError);
                                    }
                                }
                            } else {
                                // Supprimer le schedule exécuté (schedule ponctuel)
                                console.log('📅 One-time schedule - removing after execution');
                                const filteredSchedules = userSchedules.filter(s => s !== schedule);
                                schedules.set(userId, filteredSchedules);
                                
                                // Supprimer de la DB
                                try {
                                    await supabase
                                        .from('schedules')
                                        .delete()
                                        .eq('user_id', userId)
                                        .eq('ad_id', schedule.adId);
                                    console.log('✅ One-time schedule removed from database');
                                } catch (dbError) {
                                    console.error('⚠️ Error removing schedule from DB:', dbError);
                                }
                            }
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

// Fonction pour exécuter les calendar schedules (optimisée pour grandes quantités d'ads)
// Fonction pour vérifier si une exécution similaire existe déjà dans l'historique récent
async function checkRecentExecution(
    userId: string,
    adId: string,
    scheduleDate: string,
    slotId: string,
    action: 'ACTIVE' | 'STOP',
    withinMinutes: number = 5
): Promise<boolean> {
    try {
        const cutoffTime = new Date();
        cutoffTime.setMinutes(cutoffTime.getMinutes() - withinMinutes);
        
        const { data, error } = await supabase
            .from('calendar_schedule_history')
            .select('id')
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .eq('schedule_date', scheduleDate)
            .eq('slot_id', slotId)
            .eq('action', action)
            .gte('execution_time', cutoffTime.toISOString())
            .limit(1);
        
        if (error) {
            console.error('❌ Error checking recent execution:', error);
            return false; // En cas d'erreur, permettre l'exécution pour éviter de bloquer
        }
        
        return (data && data.length > 0);
    } catch (err: any) {
        console.error('❌ Exception checking recent execution:', err);
        return false; // En cas d'erreur, permettre l'exécution
    }
}

// Fonction pour enregistrer l'exécution dans l'historique
async function logCalendarScheduleExecution(
    userId: string,
    adId: string,
    scheduleDate: string,
    slotId: string,
    startMinutes: number,
    stopMinutes: number,
    action: 'ACTIVE' | 'STOP',
    status: 'SUCCESS' | 'ERROR' | 'PENDING',
    executionTime: Date,
    timezone: string,
    errorMessage?: string,
    facebookApiResponse?: any
) {
    try {
        // Vérifier si une exécution similaire existe déjà dans les 10 dernières minutes
        const recentExecution = await checkRecentExecution(userId, adId, scheduleDate, slotId, action, 10);
        if (recentExecution) {
            console.log(`⚠️ Duplicate execution detected and skipped: ${action} for ad ${adId}, slot ${slotId} on ${scheduleDate}`);
            return; // Ne pas enregistrer les doublons
        }
        
        const { error } = await supabase
            .from('calendar_schedule_history')
            .insert({
                user_id: userId,
                ad_id: adId,
                schedule_date: scheduleDate,
                slot_id: slotId,
                start_minutes: startMinutes,
                stop_minutes: stopMinutes,
                action: action,
                status: status,
                execution_time: executionTime.toISOString(),
                timezone: timezone,
                error_message: errorMessage || null,
                facebook_api_response: facebookApiResponse || null
            });
        
        if (error) {
            console.error('❌ Error logging calendar schedule execution:', error);
        } else {
            console.log(`✅ Calendar schedule execution logged: ${action} for ad ${adId} on ${scheduleDate}`);
        }
    } catch (err: any) {
        console.error('❌ Exception logging calendar schedule execution:', err);
    }
}

async function executeCalendarSchedules(calendarSchedules: any[], now: Date) {
    try {
        
        for (const dbSchedule of calendarSchedules) {
            try {
                const userId = dbSchedule.user_id;
                const adId = dbSchedule.ad_id;
                const timezone = dbSchedule.timezone || 'UTC';
                
                // Recharger le schedule depuis la DB pour avoir les dernières valeurs
                const { data: freshSchedule, error: refreshError } = await supabase
                    .from('calendar_schedules')
                    .select('*')
                    .eq('user_id', userId)
                    .eq('ad_id', adId)
                    .single();
                
                if (refreshError || !freshSchedule) {
                    console.error(`❌ [CALENDAR] Error refreshing schedule for ad ${adId}:`, refreshError);
                    continue;
                }
                
                // Obtenir la date et l'heure actuelle dans le timezone du schedule
                const currentDateInTimezone = getCurrentDateInTimezone(timezone);
                const currentMinutesInTimezone = getCurrentMinutesInTimezone(timezone);
                
                
                // Vérifier si ce schedule a un créneau pour aujourd'hui
                const scheduleData = freshSchedule.schedule_data || {};
                const daySchedule = scheduleData[currentDateInTimezone];
                
                console.log(`🔍 [CALENDAR] Checking ad ${adId} for date ${currentDateInTimezone}, available dates: ${Object.keys(scheduleData).join(', ')}`);
                
                if (!daySchedule || !daySchedule.timeSlots || daySchedule.timeSlots.length === 0) {
                    console.log(`⏭️ [CALENDAR] No schedule for today (${currentDateInTimezone}) for ad ${adId}`);
                    continue; // Pas de schedule pour aujourd'hui
                }
                
                console.log(`✅ [CALENDAR] Found ${daySchedule.timeSlots.length} slot(s) for today for ad ${adId}`);
                
                
                // Vérifier chaque slot pour voir si on doit exécuter une action
                for (const slot of daySchedule.timeSlots) {
                    if (slot.enabled === false) {
                        console.log(`⏭️ [CALENDAR] Slot ${slot.id} is disabled, skipping`);
                        continue; // Slot désactivé
                    }
                    
                    // Log pour déboguer quand on est proche de l'heure
                    const timeDiffStart = Math.abs(currentMinutesInTimezone - slot.startMinutes);
                    const timeDiffStop = Math.abs(currentMinutesInTimezone - slot.stopMinutes);
                    if (timeDiffStart <= 5 || timeDiffStop <= 5) {
                        console.log(`🔍 [CALENDAR] Slot ${slot.id} for ad ${adId}: current=${currentMinutesInTimezone}, start=${slot.startMinutes}, stop=${slot.stopMinutes}, diffStart=${timeDiffStart}, diffStop=${timeDiffStop}`);
                    }
                    
                    // Vérifier si on doit activer (fenêtre de 2 minutes pour plus de précision)
                    // Le service s'exécute toutes les 5 secondes, donc une fenêtre de 2 minutes est suffisante
                    const isActiveTime = isTimeMatch(currentMinutesInTimezone, slot.startMinutes, 2);
                    const isStopTime = isTimeMatch(currentMinutesInTimezone, slot.stopMinutes, 2);
                    
                    if (isActiveTime) {
                        console.log(`✅ [CALENDAR] ACTIVE time match found for ad ${adId}, slot ${slot.id}, time ${slot.startMinutes}`);
                        
                        // Récupérer le token Facebook d'abord pour vérifier le statut
                        const tokenRow = await getFacebookToken(userId);
                        if (!tokenRow || !tokenRow.token) {
                            console.error(`❌ [CALENDAR] No token found for user ${userId}`);
                            continue;
                        }
                        
                        // Récupérer le statut actuel de l'ad AVANT de vérifier les exécutions
                        let adStatusBefore = 'UNKNOWN';
                        try {
                            const statusResponse = await fetch(`https://graph.facebook.com/v18.0/${adId}?fields=status&access_token=${tokenRow.token}`);
                            if (statusResponse.ok) {
                                const statusData = await statusResponse.json();
                                adStatusBefore = statusData.status || 'UNKNOWN';
                            }
                        } catch (statusError) {
                            console.error(`⚠️ [CALENDAR] Error checking ad status:`, statusError);
                        }
                        
                        console.log(`🔍 [CALENDAR] Current ad status: ${adStatusBefore}`);
                        
                        // Vérifier si on a déjà exécuté ACTIVE pour ce slot aujourd'hui
                        const alreadyExecutedActive = freshSchedule.last_executed_date === currentDateInTimezone && 
                            freshSchedule.last_executed_slot_id === slot.id &&
                            freshSchedule.last_executed_action === 'ACTIVE';
                        
                        // Vérifier dans l'historique si une exécution récente existe (fenêtre de 2 minutes pour éviter les doublons)
                        const recentExecution = await checkRecentExecution(
                            userId, 
                            adId, 
                            currentDateInTimezone, 
                            slot.id, 
                            'ACTIVE', 
                            2 // 2 minutes pour éviter les doublons
                        );
                        
                        console.log(`🔍 [CALENDAR] Already executed ACTIVE today: ${alreadyExecutedActive}, Recent execution found: ${recentExecution}`);
                        
                        // Logique améliorée : exécuter ACTIVE si :
                        // 1. L'ad n'est PAS déjà ACTIVE, OU
                        // 2. L'ad est ACTIVE mais on n'a pas encore exécuté ACTIVE pour ce slot aujourd'hui, OU
                        // 3. L'ad est ACTIVE mais il n'y a pas eu d'exécution récente (l'ad a pu être modifiée manuellement)
                        if (adStatusBefore === 'ACTIVE' && alreadyExecutedActive && recentExecution) {
                            // L'ad est déjà ACTIVE, on a déjà exécuté ACTIVE pour ce slot aujourd'hui, 
                            // et il y a eu une exécution récente - donc l'ad est toujours dans l'état attendu
                            console.log(`⏭️ [CALENDAR] Skipping ACTIVE - ad already ACTIVE and already executed recently for slot ${slot.id}`);
                            continue;
                        }
                        
                        // Si l'ad est ACTIVE mais qu'on n'a pas d'exécution récente, c'est qu'elle a pu être modifiée manuellement
                        // ou qu'il y a eu un problème - on réexécute pour s'assurer qu'elle reste ACTIVE
                        if (adStatusBefore === 'ACTIVE' && !recentExecution) {
                            console.log(`⚠️ [CALENDAR] Ad is ACTIVE but no recent execution found - may have been manually changed, re-executing ACTIVE`);
                        }
                        
                        console.log(`✅ [CALENDAR] Proceeding with ACTIVE execution (status: ${adStatusBefore}, needs activation: ${adStatusBefore !== 'ACTIVE'})`);
                        
                        console.log(`🔄 [CALENDAR] Executing ACTIVE for ad ${adId}, slot ${slot.id}, time ${slot.startMinutes}, CURRENT STATUS: ${adStatusBefore}`);
                        
                        // Appeler Facebook API pour activer l'ad avec retry et gestion d'erreurs
                        let responseData: any = {};
                        let executionSuccess = false;
                        try {
                            const response = await axios.post(
                                `https://graph.facebook.com/v18.0/${adId}`,
                                { status: 'ACTIVE' },
                                {
                                    headers: {
                                        'Authorization': `Bearer ${tokenRow.token}`,
                                        'Content-Type': 'application/json'
                                    },
                                    timeout: 30000
                                }
                            );
                            responseData = response.data;
                            executionSuccess = true;
                        } catch (apiError: any) {
                            const errorData = apiError.response?.data?.error || {};
                            const errorCode = errorData.code;
                            const errorMessage = errorData.message || apiError.message;
                            
                            // Gestion spécifique des erreurs de permissions (#10)
                            if (errorCode === 10) {
                                console.error(`❌ [CALENDAR] Permission denied for ACTIVE action on ad ${adId}: ${errorMessage}`);
                                await logCalendarScheduleExecution(
                                    userId,
                                    adId,
                                    currentDateInTimezone,
                                    slot.id,
                                    slot.startMinutes,
                                    slot.stopMinutes,
                                    'ACTIVE',
                                    'ERROR',
                                    now,
                                    timezone,
                                    `Permission denied: ${errorMessage}`,
                                    errorData
                                );
                                continue; // Skip ce slot
                            }
                            
                            // Gestion des rate limits
                            if (errorCode === 17 || errorCode === 4 || apiError.response?.status === 429) {
                                console.warn(`⚠️ [CALENDAR] Rate limit hit for ACTIVE action on ad ${adId}, will retry later`);
                                // Ne pas enregistrer comme erreur, le système retry automatiquement
                                continue;
                            }
                            
                            responseData = apiError.response?.data || {};
                            console.error(`❌ [CALENDAR] Facebook API error for ACTIVE: ad ${adId}, error:`, errorMessage);
                        }
                        
                        if (executionSuccess) {
                            // Vérifier le statut de l'ad APRÈS l'exécution
                            let adStatusAfter = 'UNKNOWN';
                            try {
                                const statusResponseAfter = await fetch(`https://graph.facebook.com/v18.0/${adId}?fields=status&access_token=${tokenRow.token}`);
                                if (statusResponseAfter.ok) {
                                    const statusDataAfter = await statusResponseAfter.json();
                                    adStatusAfter = statusDataAfter.status || 'UNKNOWN';
                                }
                            } catch (statusError) {
                                // Ignorer les erreurs
                            }
                            
                            console.log(`✅ [CALENDAR] ACTIVE executed for ad ${adId}, STATUS BEFORE: ${adStatusBefore}, STATUS AFTER: ${adStatusAfter}`);
                            
                            // Mettre à jour le tracking d'exécution
                            await supabase
                                .from('calendar_schedules')
                                .update({
                                    last_executed_date: currentDateInTimezone,
                                    last_executed_slot_id: slot.id,
                                    last_executed_action: 'ACTIVE',
                                    updated_at: new Date().toISOString()
                                })
                                .eq('user_id', userId)
                                .eq('ad_id', adId);
                            
                            // Enregistrer dans l'historique
                            await logCalendarScheduleExecution(
                                userId,
                                adId,
                                currentDateInTimezone,
                                slot.id,
                                slot.startMinutes,
                                slot.stopMinutes,
                                'ACTIVE',
                                'SUCCESS',
                                now,
                                timezone,
                                undefined,
                                responseData
                            );
                            
                            // Log
                            await createLog(userId, "CALENDAR_SCHEDULE_EXECUTE", {
                                adId,
                                action: 'ACTIVE',
                                slotId: slot.id,
                                date: currentDateInTimezone,
                                time: slot.startMinutes
                            });
                        } else {
                            const errorMessage = responseData.error?.message || JSON.stringify(responseData);
                            console.error(`❌ [CALENDAR] Facebook API error for ACTIVE: ad ${adId}, error:`, errorMessage);
                            
                            // Enregistrer l'erreur dans l'historique
                            await logCalendarScheduleExecution(
                                userId,
                                adId,
                                currentDateInTimezone,
                                slot.id,
                                slot.startMinutes,
                                slot.stopMinutes,
                                'ACTIVE',
                                'ERROR',
                                now,
                                timezone,
                                errorMessage,
                                responseData
                            );
                        }
                    }
                    
                    // Vérifier si on doit arrêter (fenêtre de 2 minutes pour plus de précision)
                    if (isStopTime) {
                        console.log(`✅ [CALENDAR] STOP time match found for ad ${adId}, slot ${slot.id}, time ${slot.stopMinutes}`);
                        
                        // Récupérer le token Facebook d'abord pour vérifier le statut
                        const tokenRow = await getFacebookToken(userId);
                        if (!tokenRow || !tokenRow.token) {
                            console.error(`❌ [CALENDAR] No token found for user ${userId}`);
                            continue;
                        }
                        
                        // Récupérer le statut actuel de l'ad AVANT de vérifier les exécutions
                        let adStatusBefore = 'UNKNOWN';
                        try {
                            const statusData = await fetchFbGraph(tokenRow.token, `${adId}?fields=status`, undefined, userId, {
                                maxRetries: 2,
                                retryDelay: 500
                            });
                            adStatusBefore = statusData.status || 'UNKNOWN';
                        } catch (statusError: any) {
                            console.error(`⚠️ [CALENDAR] Error checking ad status:`, statusError.message || statusError);
                            // Si c'est une erreur de permissions, skip ce slot
                            if (statusError.message?.includes('Permission denied') || statusError.message?.includes('does not have permission')) {
                                console.error(`❌ [CALENDAR] Permission denied for ad ${adId}, skipping slot ${slot.id}`);
                                continue;
                            }
                        }
                        
                        console.log(`🔍 [CALENDAR] Current ad status: ${adStatusBefore}`);
                        
                        // Vérifier si on a déjà exécuté STOP pour ce slot aujourd'hui
                        const alreadyExecutedStop = freshSchedule.last_executed_date === currentDateInTimezone && 
                            freshSchedule.last_executed_slot_id === slot.id &&
                            freshSchedule.last_executed_action === 'STOP';
                        
                        // Vérifier dans l'historique si une exécution récente existe (fenêtre de 2 minutes pour éviter les doublons)
                        const recentExecution = await checkRecentExecution(
                            userId, 
                            adId, 
                            currentDateInTimezone, 
                            slot.id, 
                            'STOP', 
                            2 // 2 minutes pour éviter les doublons
                        );
                        
                        console.log(`🔍 [CALENDAR] Already executed STOP today: ${alreadyExecutedStop}, Recent execution found: ${recentExecution}`);
                        
                        // Logique améliorée : exécuter STOP si :
                        // 1. L'ad n'est PAS déjà PAUSED, OU
                        // 2. L'ad est PAUSED mais on n'a pas encore exécuté STOP pour ce slot aujourd'hui, OU
                        // 3. L'ad est PAUSED mais il n'y a pas eu d'exécution récente (l'ad a pu être modifiée manuellement)
                        if (adStatusBefore === 'PAUSED' && alreadyExecutedStop && recentExecution) {
                            // L'ad est déjà PAUSED, on a déjà exécuté STOP pour ce slot aujourd'hui, 
                            // et il y a eu une exécution récente - donc l'ad est toujours dans l'état attendu
                            console.log(`⏭️ [CALENDAR] Skipping STOP - ad already PAUSED and already executed recently for slot ${slot.id}`);
                            continue;
                        }
                        
                        // Si l'ad est PAUSED mais qu'on n'a pas d'exécution récente, c'est qu'elle a pu être modifiée manuellement
                        // ou qu'il y a eu un problème - on réexécute pour s'assurer qu'elle reste PAUSED
                        if (adStatusBefore === 'PAUSED' && !recentExecution) {
                            console.log(`⚠️ [CALENDAR] Ad is PAUSED but no recent execution found - may have been manually changed, re-executing STOP`);
                        }
                        
                        console.log(`✅ [CALENDAR] Proceeding with STOP execution (status: ${adStatusBefore}, needs pausing: ${adStatusBefore !== 'PAUSED'})`);
                        
                        console.log(`🔄 [CALENDAR] Executing STOP for ad ${adId}, slot ${slot.id}, time ${slot.stopMinutes}, CURRENT STATUS: ${adStatusBefore}`);
                        
                        // Appeler Facebook API pour arrêter l'ad avec retry et gestion d'erreurs
                        let responseData: any = {};
                        let executionSuccess = false;
                        try {
                            const response = await axios.post(
                                `https://graph.facebook.com/v18.0/${adId}`,
                                { status: 'PAUSED' },
                                {
                                    headers: {
                                        'Authorization': `Bearer ${tokenRow.token}`,
                                        'Content-Type': 'application/json'
                                    },
                                    timeout: 30000
                                }
                            );
                            responseData = response.data;
                            executionSuccess = true;
                        } catch (apiError: any) {
                            const errorData = apiError.response?.data?.error || {};
                            const errorCode = errorData.code;
                            const errorMessage = errorData.message || apiError.message;
                            
                            // Gestion spécifique des erreurs de permissions (#10)
                            if (errorCode === 10) {
                                console.error(`❌ [CALENDAR] Permission denied for STOP action on ad ${adId}: ${errorMessage}`);
                                await logCalendarScheduleExecution(
                                    userId,
                                    adId,
                                    currentDateInTimezone,
                                    slot.id,
                                    slot.startMinutes,
                                    slot.stopMinutes,
                                    'STOP',
                                    'ERROR',
                                    now,
                                    timezone,
                                    `Permission denied: ${errorMessage}`,
                                    errorData
                                );
                                continue; // Skip ce slot
                            }
                            
                            // Gestion des rate limits
                            if (errorCode === 17 || errorCode === 4 || apiError.response?.status === 429) {
                                console.warn(`⚠️ [CALENDAR] Rate limit hit for STOP action on ad ${adId}, will retry later`);
                                // Ne pas enregistrer comme erreur, le système retry automatiquement
                                continue;
                            }
                            
                            responseData = apiError.response?.data || {};
                            console.error(`❌ [CALENDAR] Facebook API error for STOP: ad ${adId}, error:`, errorMessage);
                        }
                        
                        if (executionSuccess) {
                            // Vérifier le statut de l'ad APRÈS l'exécution
                            let adStatusAfter = 'UNKNOWN';
                            try {
                                const statusDataAfter = await fetchFbGraph(tokenRow.token, `${adId}?fields=status`, undefined, userId, {
                                    maxRetries: 1,
                                    retryDelay: 500
                                });
                                adStatusAfter = statusDataAfter.status || 'UNKNOWN';
                            } catch (statusError) {
                                // Ignorer les erreurs de vérification du statut
                                console.warn(`⚠️ [CALENDAR] Could not verify ad status after STOP execution`);
                            }
                            
                            console.log(`✅ [CALENDAR] STOP executed for ad ${adId}, STATUS BEFORE: ${adStatusBefore}, STATUS AFTER: ${adStatusAfter}`);
                            
                            // Mettre à jour le tracking d'exécution
                            await supabase
                                .from('calendar_schedules')
                                .update({
                                    last_executed_date: currentDateInTimezone,
                                    last_executed_slot_id: slot.id,
                                    last_executed_action: 'STOP',
                                    updated_at: new Date().toISOString()
                                })
                                .eq('user_id', userId)
                                .eq('ad_id', adId);
                            
                            // Enregistrer dans l'historique
                            await logCalendarScheduleExecution(
                                userId,
                                adId,
                                currentDateInTimezone,
                                slot.id,
                                slot.startMinutes,
                                slot.stopMinutes,
                                'STOP',
                                'SUCCESS',
                                now,
                                timezone,
                                undefined,
                                responseData
                            );
                            
                            // Log
                            await createLog(userId, "CALENDAR_SCHEDULE_EXECUTE", {
                                adId,
                                action: 'STOP',
                                slotId: slot.id,
                                date: currentDateInTimezone,
                                time: slot.stopMinutes
                            });
                        } else {
                            const errorMessage = responseData.error?.message || JSON.stringify(responseData);
                            console.error(`❌ [CALENDAR] Facebook API error for STOP: ad ${adId}, error:`, errorMessage);
                            
                            // Enregistrer l'erreur dans l'historique
                            await logCalendarScheduleExecution(
                                userId,
                                adId,
                                currentDateInTimezone,
                                slot.id,
                                slot.startMinutes,
                                slot.stopMinutes,
                                'STOP',
                                'ERROR',
                                now,
                                timezone,
                                errorMessage,
                                responseData
                            );
                        }
                    }
                }
            } catch (error: any) {
                console.error(`❌ Error executing calendar schedule for ad ${dbSchedule.ad_id}:`, error);
            }
        }
    } catch (error) {
        console.error('❌ Error in executeCalendarSchedules:', error);
    }
}

// Démarrer le service de schedules (appelé toutes les minutes)
export async function startScheduleService() {
    console.log('Starting schedule service...');
    
    // Charger les schedules depuis la base de données au démarrage
    await loadSchedulesFromDB();
    
    console.log(' Schedule service started - checking every 1 minute');
    
    // Exécuter toutes les minutes (60000ms = 1 minute)
    setInterval(() => {
        executeSchedules();
    }, 60000); // 1 minute
    
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

// Endpoint pour cron job externe (gratuit) - appelé par des services comme cron-job.org, easycron, etc.
export async function cronExecuteSchedules(req: Request, res: Response) {
    try {
        // Vérifier le secret pour la sécurité (passé en query param ou header)
        const providedSecret = req.query.secret as string || req.headers['x-cron-secret'] as string;
        const expectedSecret = process.env.CRON_SECRET || 'change-this-secret-in-production';
        
        if (!providedSecret || providedSecret !== expectedSecret) {
            console.warn('⚠️ Unauthorized cron execution attempt');
            return res.status(401).json({
                success: false,
                message: "Unauthorized - Invalid secret"
            });
        }
        
        console.log('⏰ [CRON] Starting scheduled execution...');
        const startTime = Date.now();
        await executeSchedules();
        const duration = Date.now() - startTime;
        
        console.log(`✅ [CRON] Schedule execution completed in ${duration}ms`);
        
        return res.json({
            success: true,
            message: "Schedule execution completed",
            duration: `${duration}ms`,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        console.error('❌ [CRON] Error in cron execute schedules:', error);
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
        
        // D'abord chercher dans la mémoire
        let userSchedules = schedules.get(userId) || [];
        let adSchedules = userSchedules.filter(s => s.adId === adId);
        
        // Si pas trouvé en mémoire, chercher dans la base de données
        if (adSchedules.length === 0) {
            console.log('⚠️ No schedules found in memory, checking database...');
            try {
                const { data: dbSchedules, error } = await supabase
                    .from('schedules')
                    .select('*')
                    .eq('user_id', userId)
                    .eq('ad_id', adId);
                
                if (error) {
                    console.error('⚠️ Error loading schedules from DB:', error);
                } else if (dbSchedules && dbSchedules.length > 0) {
                    console.log(`✅ Found ${dbSchedules.length} schedule(s) in database, loading to memory...`);
                    // Convertir et charger dans la mémoire
                    adSchedules = dbSchedules.map(dbToScheduleData);
                    
                    // Mettre à jour la Map mémoire pour les prochaines requêtes
                    if (!schedules.has(userId)) {
                        schedules.set(userId, []);
                    }
                    // Ajouter les schedules trouvés à la mémoire (éviter les doublons)
                    const existingAdIds = new Set(schedules.get(userId)!.map(s => `${s.adId}_${s.scheduleType}`));
                    for (const schedule of adSchedules) {
                        const key = `${schedule.adId}_${schedule.scheduleType}`;
                        if (!existingAdIds.has(key)) {
                            schedules.get(userId)!.push(schedule);
                        }
                    }
                    console.log('✅ Schedules loaded from database to memory');
                }
            } catch (dbError) {
                console.error('⚠️ Error loading schedules from database:', dbError);
                // Continue avec les schedules vides
            }
        }
        
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
        
        console.log(`✅ Found ${schedulesInfo.length} schedule(s) for ad:`, schedulesInfo);
        
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

// Fonction pour récupérer toutes les ads avec des schedules actifs
export async function getAllScheduledAds(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        
        console.log('🔍 Getting all scheduled ads for user:', userId);
        
        // Récupérer tous les schedules depuis la DB
        let dbSchedules: any[] = [];
        try {
            const { data, error } = await supabase
                .from('schedules')
                .select('*')
                .eq('user_id', userId);
            
            if (error) {
                console.error('⚠️ Error loading schedules from DB:', error);
                // Fallback: utiliser la mémoire
                const userSchedules = schedules.get(userId) || [];
                dbSchedules = userSchedules.map(s => ({
                    ad_id: s.adId,
                    schedule_type: s.scheduleType,
                    scheduled_date: s.scheduledDate,
                    timezone: s.timezone,
                    start_minutes: s.startMinutes,
                    end_minutes: s.endMinutes,
                    stop_minutes_1: s.stopMinutes1,
                    stop_minutes_2: s.stopMinutes2,
                    start_minutes_2: s.startMinutes2,
                    executed_at: s.executedAt,
                    last_action: s.lastAction,
                    last_execution_date: s.lastExecutionDate
                }));
            } else {
                dbSchedules = data || [];
            }
        } catch (dbError) {
            console.error('⚠️ Error loading schedules from DB:', dbError);
            // Fallback: utiliser la mémoire
            const userSchedules = schedules.get(userId) || [];
            dbSchedules = userSchedules.map(s => ({
                ad_id: s.adId,
                schedule_type: s.scheduleType,
                scheduled_date: s.scheduledDate,
                timezone: s.timezone,
                start_minutes: s.startMinutes,
                end_minutes: s.endMinutes,
                stop_minutes_1: s.stopMinutes1,
                stop_minutes_2: s.stopMinutes2,
                start_minutes_2: s.startMinutes2,
                executed_at: s.executedAt,
                last_action: s.lastAction,
                last_execution_date: s.lastExecutionDate
            }));
        }
        
        if (dbSchedules.length === 0) {
            return res.json({
                success: true,
                data: {
                    ads: [],
                    total: 0
                }
            });
        }
        
        // Récupérer le token Facebook
        const tokenRow = await getFacebookToken(userId);
        if (!tokenRow || !tokenRow.token) {
            return res.status(400).json({
                success: false,
                message: "No Facebook token found. Please reconnect your Facebook account."
            });
        }
        
        // Grouper les schedules par ad_id
        const schedulesByAdId = new Map<string, any[]>();
        for (const schedule of dbSchedules) {
            const adId = schedule.ad_id;
            if (!schedulesByAdId.has(adId)) {
                schedulesByAdId.set(adId, []);
            }
            schedulesByAdId.get(adId)!.push(schedule);
        }
        
        // Récupérer les détails de chaque ad depuis Facebook
        const adsWithSchedules = [];
        for (const [adId, adSchedules] of schedulesByAdId.entries()) {
            try {
                // Récupérer les détails de base de l'ad
                const endpoint = `${adId}?fields=id,name,status,created_time,updated_time,adset_id,campaign_id`;
                const adDetails = await fetchFbGraph(tokenRow.token, endpoint);
                
                // Formater les schedules pour cette ad
                const formattedSchedules = adSchedules.map(s => ({
                    id: s.id, // Inclure l'ID du schedule
                    scheduleType: s.schedule_type,
                    scheduledDate: s.scheduled_date,
                    timezone: s.timezone,
                    startMinutes: s.start_minutes,
                    endMinutes: s.end_minutes,
                    stopMinutes1: s.stop_minutes_1,
                    stopMinutes2: s.stop_minutes_2,
                    startMinutes2: s.start_minutes_2,
                    executedAt: s.executed_at,
                    lastAction: s.last_action,
                    lastExecutionDate: s.last_execution_date,
                    isRecurring: s.schedule_type === 'RECURRING_DAILY',
                    startTime: s.start_minutes ? `${Math.floor(s.start_minutes / 60)}:${(s.start_minutes % 60).toString().padStart(2, '0')}` : null,
                    endTime: s.end_minutes ? `${Math.floor(s.end_minutes / 60)}:${(s.end_minutes % 60).toString().padStart(2, '0')}` : null,
                    stopTime1: s.stop_minutes_1 ? `${Math.floor(s.stop_minutes_1 / 60)}:${(s.stop_minutes_1 % 60).toString().padStart(2, '0')}` : null,
                    stopTime2: s.stop_minutes_2 ? `${Math.floor(s.stop_minutes_2 / 60)}:${(s.stop_minutes_2 % 60).toString().padStart(2, '0')}` : null,
                    startTime2: s.start_minutes_2 ? `${Math.floor(s.start_minutes_2 / 60)}:${(s.start_minutes_2 % 60).toString().padStart(2, '0')}` : null
                }));
                
                adsWithSchedules.push({
                    ...adDetails,
                    schedules: formattedSchedules,
                    totalSchedules: formattedSchedules.length
                });
            } catch (adError: any) {
                console.error(`⚠️ Error fetching ad ${adId}:`, adError);
                // Inclure quand même l'ad avec les schedules même si les détails ne peuvent pas être récupérés
                adsWithSchedules.push({
                    id: adId,
                    name: 'Unknown',
                    status: 'UNKNOWN',
                    error: adError.message,
                    schedules: adSchedules.map(s => ({
                        id: s.id, // Inclure l'ID du schedule
                        scheduleType: s.schedule_type,
                        scheduledDate: s.scheduled_date,
                        timezone: s.timezone,
                        isRecurring: s.schedule_type === 'RECURRING_DAILY'
                    })),
                    totalSchedules: adSchedules.length
                });
            }
        }
        
        console.log(`✅ Found ${adsWithSchedules.length} ad(s) with active schedules`);
        
        return res.json({
            success: true,
            data: {
                ads: adsWithSchedules,
                total: adsWithSchedules.length
            }
        });
        
    } catch (error: any) {
        console.error('❌ Error getting scheduled ads:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction pour supprimer les schedules d'une ad
// Fonction helper pour supprimer les schedules récurrents d'une ad (utilisée par calendarScheduleController)
export async function disableRecurringScheduleForAd(userId: string, adId: string): Promise<void> {
    try {
        // Supprimer de la base de données
        const { error: dbError } = await supabase
            .from('schedules')
            .delete()
            .eq('user_id', userId)
            .eq('ad_id', adId)
            .eq('schedule_type', 'RECURRING_DAILY');
        
        if (dbError) {
            console.error('⚠️ Error deleting recurring schedule from DB:', dbError);
        } else {
            console.log('✅ Recurring schedule deleted from database');
        }
        
        // Supprimer de la mémoire
        const userSchedules = schedules.get(userId) || [];
        const filteredSchedules = userSchedules.filter(s => 
            !(s.adId === adId && s.scheduleType === 'RECURRING_DAILY')
        );
        schedules.set(userId, filteredSchedules);
        
        console.log(`✅ Recurring schedule disabled for ad ${adId} (removed from memory)`);
    } catch (error) {
        console.error('⚠️ Error disabling recurring schedule:', error);
        throw error;
    }
}

export async function deleteAdSchedules(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        console.log('🗑️ Deleting schedules for ad:', adId);
        
        const userSchedules = schedules.get(userId) || [];
        const initialCount = userSchedules.length;
        
        // Supprimer de la base de données
        try {
            const { error: dbError } = await supabase
                .from('schedules')
                .delete()
                .eq('user_id', userId)
                .eq('ad_id', adId);
            
            if (dbError) {
                console.error('⚠️ Error deleting schedules from DB:', dbError);
            } else {
                console.log('✅ Schedules deleted from database');
            }
        } catch (dbError) {
            console.error('⚠️ Error deleting schedules from DB:', dbError);
        }
        
        // Filter out all schedules for this ad (mémoire)
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

// Fonction pour supprimer un schedule spécifique par son ID
export async function deleteSchedule(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { scheduleId } = req.params;
        
        console.log('🗑️ Deleting schedule:', scheduleId);
        
        // Supprimer de la base de données
        try {
            const { data: deletedSchedule, error: dbError } = await supabase
                .from('schedules')
                .delete()
                .eq('id', scheduleId)
                .eq('user_id', userId)
                .select()
                .single();
            
            if (dbError) {
                console.error('⚠️ Error deleting schedule from DB:', dbError);
                return res.status(500).json({
                    success: false,
                    message: "Failed to delete schedule from database"
                });
            }
            
            if (!deletedSchedule) {
                return res.status(404).json({
                    success: false,
                    message: "Schedule not found"
                });
            }
            
            console.log('✅ Schedule deleted from database');
            
            // Supprimer de la mémoire
            const userSchedules = schedules.get(userId) || [];
            const filteredSchedules = userSchedules.filter(s => {
                // Pour les schedules en mémoire, on ne peut pas les matcher par ID
                // On doit les matcher par les propriétés du schedule supprimé
                return !(
                    s.adId === deletedSchedule.ad_id &&
                    s.scheduleType === deletedSchedule.schedule_type &&
                    s.scheduledDate === deletedSchedule.scheduled_date &&
                    s.timezone === deletedSchedule.timezone
                );
            });
            
            schedules.set(userId, filteredSchedules);
            console.log('✅ Schedule removed from memory cache');
            
            // Log de suppression
            try {
                await createLog(userId, "SCHEDULE_DELETE", {
                    scheduleId,
                    adId: deletedSchedule.ad_id,
                    scheduleType: deletedSchedule.schedule_type,
                    deletedAt: new Date().toISOString()
                });
            } catch (logError) {
                console.error('⚠️ Error creating delete log:', logError);
            }
            
            return res.json({
                success: true,
                message: "Schedule deleted successfully",
                data: {
                    scheduleId,
                    adId: deletedSchedule.ad_id
                }
            });
            
        } catch (dbError: any) {
            console.error('❌ Error deleting schedule:', dbError);
            return res.status(500).json({
                success: false,
                message: dbError.message || "Server error"
            });
        }
        
    } catch (error: any) {
        console.error('❌ Error in delete schedule:', error);
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
