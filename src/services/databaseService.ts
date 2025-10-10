import { supabase } from '../supabaseClient.js';

// Service pour gérer les tokens Facebook
export class TokenService {
  // Sauvegarder un token Facebook
  static async saveToken(userId: string, token: string, scopes?: string, meta?: any) {
    const { data, error } = await supabase
      .from('access_tokens')
      .insert({
        userId: userId,
        token,
        scopes,
        meta
      } as any)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // Récupérer les tokens d'un utilisateur
  static async getUserTokens(userId: string) {
    const { data, error } = await supabase
      .from('access_tokens')
      .select('*')
      .eq('userId', userId)
      .order('id', { ascending: false });

    if (error) throw error;
    return data;
  }

  // Mettre à jour un token
  static async updateToken(tokenId: number, updates: { token?: string; scopes?: string; meta?: any }) {
    const { data, error } = await (supabase as any)
      .from('access_tokens')
      .update(updates)
      .eq('id', tokenId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // Supprimer un token
  static async deleteToken(tokenId: number) {
    const { error } = await supabase
      .from('access_tokens')
      .delete()
      .eq('id', tokenId);

    if (error) throw error;
    return true;
  }
}

// Service pour gérer les logs
export class LogService {
  // Créer un log
  static async createLog(userId: string, action: string, details?: any, ip?: string, userAgent?: string) {
    const { data, error } = await supabase
      .from('logs')
      .insert({
        userId: userId,
        action,
        details,
        ip,
        userAgent: userAgent
      } as any)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // Récupérer les logs d'un utilisateur
  static async getUserLogs(userId: string, limit = 50, offset = 0) {
    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .eq('userId', userId)
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  }

  // Récupérer les logs par action
  static async getLogsByAction(userId: string, action: string, limit = 50) {
    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .eq('userId', userId)
      .eq('action', action)
      .order('id', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }
}
