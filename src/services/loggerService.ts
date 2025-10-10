import { supabase } from "../supabaseClient.js";

// Types pour les différents types de logs
export interface AdStatusChangeLog {
  adId: string;
  adName?: string;
  oldStatus: string;
  newStatus: string;
  adAccountId?: string;
  campaignId?: string;
  adsetId?: string;
}

export interface StopLossConfigLog {
  adId: string;
  adName?: string;
  condition: string; // 'SPEND', 'CPC', 'CPL', 'CPA'
  threshold: number;
  action: string; // 'PAUSE', 'ACTIVATE'
  adAccountId?: string;
  campaignId?: string;
  adsetId?: string;
}

export interface ScheduleCreateLog {
  adId: string;
  adName?: string;
  scheduleType: string; // 'START', 'STOP', 'PAUSE'
  scheduledDate: string;
  timezone: string;
  adAccountId?: string;
  campaignId?: string;
  adsetId?: string;
}

export interface GeneralLog {
  [key: string]: any;
}

// Actions disponibles
export const LOG_ACTIONS = {
  AD_STATUS_CHANGE: 'AD_STATUS_CHANGE',
  STOP_LOSS_CONFIG: 'STOP_LOSS_CONFIG',
  SCHEDULE_CREATE: 'SCHEDULE_CREATE',
  SCHEDULE_UPDATE: 'SCHEDULE_UPDATE',
  SCHEDULE_DELETE: 'SCHEDULE_DELETE',
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  TOKEN_UPLOAD: 'TOKEN_UPLOAD',
  DATA_FETCH: 'DATA_FETCH',
  ERROR: 'ERROR'
} as const;

export type LogAction = typeof LOG_ACTIONS[keyof typeof LOG_ACTIONS];

// Fonction principale de logging
export async function createLog(
  userId: string, // Supabase utilise des UUIDs (strings)
  action: LogAction,
  details: AdStatusChangeLog | StopLossConfigLog | ScheduleCreateLog | GeneralLog,
  ip?: string,
  userAgent?: string
): Promise<void> {
  try {
    const { error } = await supabase
      .from('logs')
      .insert({
        userId: userId,
        action,
        details: details as any,
        ip: ip || null,
        userAgent: userAgent || null
      } as any);
    
    if (error) {
      console.error('❌ Error creating log:', error);
    } else {
      console.log(`✅ Log created: ${action} for user ${userId}`);
    }
  } catch (error) {
    console.error('❌ Error creating log:', error);
    // Ne pas faire échouer l'opération principale si le logging échoue
  }
}

// Fonctions spécialisées pour chaque type de log

export async function logAdStatusChange(
  userId: string,
  logData: AdStatusChangeLog,
  ip?: string,
  userAgent?: string
): Promise<void> {
  await createLog(userId, LOG_ACTIONS.AD_STATUS_CHANGE, logData, ip, userAgent);
}

export async function logStopLossConfig(
  userId: string,
  logData: StopLossConfigLog,
  ip?: string,
  userAgent?: string
): Promise<void> {
  await createLog(userId, LOG_ACTIONS.STOP_LOSS_CONFIG, logData, ip, userAgent);
}

export async function logScheduleCreate(
  userId: string,
  logData: ScheduleCreateLog,
  ip?: string,
  userAgent?: string
): Promise<void> {
  await createLog(userId, LOG_ACTIONS.SCHEDULE_CREATE, logData, ip, userAgent);
}

// Fonction pour récupérer les logs d'un utilisateur
export async function getUserLogs(
  userId: string,
  limit: number = 50,
  offset: number = 0,
  action?: LogAction
) {
  let query = supabase
    .from('logs')
    .select('*')
    .eq('userId', userId)
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);

  if (action) {
    query = query.eq('action', action);
  }

  const { data: logs, error } = await query;

  if (error) {
    console.error('Error fetching logs:', error);
    return { logs: [], total: 0, hasMore: false };
  }

  // Compter le total
  let countQuery = supabase
    .from('logs')
    .select('*', { count: 'exact', head: true })
    .eq('userId', userId);

  if (action) {
    countQuery = countQuery.eq('action', action);
  }

  const { count: total } = await countQuery;

  return {
    logs: logs || [],
    total: total || 0,
    hasMore: offset + (logs?.length || 0) < (total || 0),
  };
}

// Fonction pour récupérer les logs d'une ad spécifique
export async function getAdLogs(
  userId: string,
  adId: string,
  limit: number = 20
) {
  const { data: logs, error } = await supabase
    .from('logs')
    .select('*')
    .eq('userId', userId)
    .in('action', [LOG_ACTIONS.AD_STATUS_CHANGE, LOG_ACTIONS.STOP_LOSS_CONFIG, LOG_ACTIONS.SCHEDULE_CREATE])
    .contains('details', { adId })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching ad logs:', error);
    return [];
  }

  return logs || [];
}
