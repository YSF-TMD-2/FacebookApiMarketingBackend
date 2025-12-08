import { Request, Response } from 'express';
import { Request as ExpressRequest } from '../types/express.js';
import AdminSystemSettingsService from '../services/adminSystemSettingsService.js';
import { supabase } from '../supabaseClient.js';
import { optimizedStopLossService } from '../services/optimizedStopLossService.js';
import { rateLimitManager } from '../services/rateLimitManager.js';
import { createClient } from '@supabase/supabase-js';
import { getFacebookToken, fetchFbGraph } from './facebookController.js';

// Fonction pour obtenir le client Supabase Admin (avec service_role_key)
function getSupabaseAdminClient() {
  // ⚠️ IMPORTANT: Utilise UNIQUEMENT les variables d'environnement, pas de valeurs par défaut
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!url) {
    throw new Error(
      '❌ SUPABASE_URL environment variable is required. ' +
      'Please set it in your .env file or Vercel environment variables.'
    );
  }
  
  if (!key) {
    throw new Error(
      '❌ SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is required for admin operations. ' +
      'Please set it in your .env file or Vercel environment variables.'
    );
  }
  
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * Récupérer tous les utilisateurs connectés avec leurs infos
 */
export async function getAllUsers(req: ExpressRequest, res: Response) {
  try {
    const result = await AdminSystemSettingsService.getUsersWithBatchConfig();
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || 'Failed to fetch users'
      });
    }

    // Enrichir avec les informations utilisateur de base
    const enrichedUsers = await Promise.all(
      (result.data || []).map(async (userConfig) => {
        try {
          // Récupérer les infos de base (email depuis user_roles ou access_tokens)
          const { data: tokenData } = await supabase
            .from('access_tokens')
            .select('created_at, updated_at')
            .eq('userId', userConfig.user_id)
            .order('updated_at', { ascending: false })
            .limit(1)
            .single();

          return {
            ...userConfig,
            last_token_update: tokenData ? (tokenData as any).updated_at : null,
            token_created_at: tokenData ? (tokenData as any).created_at : null
          };
        } catch (error) {
          return userConfig;
        }
      })
    );

    return res.json({
      success: true,
      data: enrichedUsers,
      count: enrichedUsers.length
    });
  } catch (error: any) {
    console.error('❌ Error in getAllUsers:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer les détails d'un utilisateur spécifique
 */
export async function getUserDetails(req: ExpressRequest, res: Response) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const [userDetailsResult, batchConfigResult] = await Promise.all([
      AdminSystemSettingsService.getUserDetails(userId),
      AdminSystemSettingsService.getUserBatchConfig(userId)
    ]);

    if (!userDetailsResult.success) {
      return res.status(500).json({
        success: false,
        message: userDetailsResult.error || 'Failed to fetch user details'
      });
    }

    // Enrichir avec la config batch
    const enrichedData = {
      ...userDetailsResult.data,
      batch_config: batchConfigResult.data || {
        batch_interval_ms: 60000,
        enabled: true,
        max_parallel_requests: 5
      }
    };

    return res.json({
      success: true,
      data: enrichedData
    });
  } catch (error: any) {
    console.error('❌ Error in getUserDetails:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer les paramètres système
 */
export async function getSystemSettings(req: ExpressRequest, res: Response) {
  try {
    const result = await AdminSystemSettingsService.getSettings();

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || 'Failed to fetch settings'
      });
    }

    return res.json({
      success: true,
      data: result.data
    });
  } catch (error: any) {
    console.error('❌ Error in getSystemSettings:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Mettre à jour les paramètres système
 */
export async function updateSystemSettings(req: ExpressRequest, res: Response) {
  try {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Key and value are required'
      });
    }

    const result = await AdminSystemSettingsService.updateSettings(key, value);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || 'Failed to update settings'
      });
    }

    // Si on met à jour stop_loss_batch, redémarrer le service
    if (key === 'stop_loss_batch' && value.enabled !== undefined) {
      if (value.enabled) {
        await optimizedStopLossService.start();
      } else {
        await optimizedStopLossService.stop();
      }
    }

    return res.json({
      success: true,
      message: 'Settings updated successfully'
    });
  } catch (error: any) {
    console.error(' Error in updateSystemSettings:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Activer/désactiver le batch stop-loss
 */
export async function toggleBatch(req: ExpressRequest, res: Response) {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'enabled must be a boolean'
      });
    }

    const result = await AdminSystemSettingsService.toggleBatch(enabled);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || 'Failed to toggle batch'
      });
    }

    // Redémarrer/arrêter le service
    if (enabled) {
      await optimizedStopLossService.start();
    } else {
      await optimizedStopLossService.stop();
    }

    return res.json({
      success: true,
      message: `Batch ${enabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error: any) {
    console.error('❌ Error in toggleBatch:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer le statut du batch
 */
export async function getBatchStatus(req: ExpressRequest, res: Response) {
  try {
    const settings = await AdminSystemSettingsService.getSettings();
    const users = await AdminSystemSettingsService.getUsersWithBatchConfig();

    return res.json({
      success: true,
      data: {
        enabled: settings.data?.stop_loss_batch?.enabled || false,
        batch_interval_ms: settings.data?.stop_loss_batch?.batch_interval_ms || 60000,
        max_parallel_requests: settings.data?.stop_loss_batch?.max_parallel_requests || 10,
        active_users: users.data?.length || 0,
        users: users.data || []
      }
    });
  } catch (error: any) {
    console.error('❌ Error in getBatchStatus:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer les quotas de tous les utilisateurs
 */
export async function getAllQuotas(req: ExpressRequest, res: Response) {
  try {
    const { data, error } = await supabase
      .from('api_quota_tracking')
      .select('*')
      .order('quota_usage_percent', { ascending: false })
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0
    });
  } catch (error: any) {
    console.error('❌ Error in getAllQuotas:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer TOUS les utilisateurs inscrits dans la base de données (auth.users)
 * Utilise une fonction RPC SQL pour accéder à auth.users via service_role_key
 */
export async function getAllRegisteredUsers(req: ExpressRequest, res: Response) {
  try {
    // Utiliser la fonction RPC SQL pour récupérer DIRECTEMENT tous les utilisateurs depuis auth.users
    // Cette fonction récupère tous les utilisateurs qui se sont inscrits, pas seulement ceux avec access_tokens
    // Script: backend/get-all-users-rpc.sql
    
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_all_users');
    
    if (rpcError) {
      console.error('Error calling RPC get_all_users:', rpcError);
      return res.status(500).json({
        success: false,
        message: `Failed to fetch users from auth.users: ${rpcError.message}. Please ensure the RPC function is created by running backend/get-all-users-rpc.sql in Supabase SQL Editor.`
      });
    }

    const rpcUsers = (rpcData || []) as any[];
    if (!rpcUsers || rpcUsers.length === 0) {
      console.log('ℹ️ No users found in auth.users');
      return res.json({
        success: true,
        data: [],
        count: 0
      });
    }

    // Récupérer les configurations batch pour tous les utilisateurs
    const userIds = rpcUsers.map((u: any) => u.id);
    const { data: batchConfigs, error: batchError } = await supabase
      .from('user_batch_config')
      .select('user_id, enabled')
      .in('user_id', userIds);

    if (batchError && batchError.code !== 'PGRST116') {
      console.warn('⚠️ Error fetching batch configs:', batchError);
    }

    // Créer un map pour accéder rapidement au statut batch
    const batchConfigMap = new Map<string, boolean>();
    (batchConfigs || []).forEach((config: any) => {
      batchConfigMap.set(config.user_id, config.enabled !== false); // true par défaut si non défini
    });

    // La fonction RPC retourne directement tous les utilisateurs depuis auth.users avec leurs rôles
    const users = rpcUsers.map((user: any) => ({
      user_id: user.id,
      email: user.email || null,
      name: user.user_metadata?.name || user.user_metadata?.full_name || user.email || 'Unknown',
      role: user.role || 'user',
      email_confirmed: !!user.email_confirmed_at,
      account_created_at: user.created_at || null,
      token_created_at: user.token_created_at || null, // Optionnel, peut être null si pas de token
      token_updated_at: user.token_updated_at || null, // Optionnel, peut être null si pas de token
      last_activity: user.last_activity || user.created_at || null,
      batch_enabled: batchConfigMap.get(user.id) ?? true // true par défaut si pas de config
    }));

    console.log('✅ Retrieved', users.length, 'registered users directly from auth.users with batch status');
    
    return res.json({
      success: true,
      data: users,
      count: users.length
    });
  } catch (error: any) {
    console.error('❌ Error in getAllRegisteredUsers:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer toutes les ads avec stop-loss actif
 */
export async function getAllStopLossAds(req: ExpressRequest, res: Response) {
  try {
    const { data: stopLossAds, error } = await supabase
      .from('stop_loss_settings')
      .select('*')
      .eq('enabled', true)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error(' Error fetching stop-loss ads:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch stop-loss ads'
      });
    }

    // Récupérer toutes les informations utilisateur via RPC
    const supabaseAdmin = getSupabaseAdminClient();
    const { data: allUsers, error: usersError } = await supabaseAdmin.rpc('get_all_users');
    
    // Créer un map pour accéder rapidement aux infos utilisateur
    const usersMap = new Map();
    if (allUsers && Array.isArray(allUsers)) {
      allUsers.forEach((user: any) => {
        console.log("this is the user data " , user)
        // Extraire le nom depuis user_metadata (full_name ou name)
        const userName = user.user_metadata?.full_name || 
                        user.user_metadata?.name || 
                        null;
        
        usersMap.set(user.id, {
          email: user.email || null,
          name: userName,
          role: user.role || 'user'
        });
        
      });
    }

    // Enrichir avec les informations utilisateur
    const enrichedAds = (stopLossAds || []).map((ad: any) => {
      const userInfo = usersMap.get(ad.user_id) || {
        email: null,
        name: null,
        role: 'user'
      };

      return {
        ...ad,
        user_email: userInfo.email,
        user_name: userInfo.name,
        user_role: userInfo.role
      };
    });

    return res.json({
      success: true,
      data: enrichedAds || [],
      count: enrichedAds.length
    });
  } catch (error: any) {
    console.error('❌ Error in getAllStopLossAds:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer les détails d'une annonce avec métriques (pour admin)
 * Utilise le token Facebook du propriétaire de l'annonce
 */
export async function getAdDetailsForAdmin(req: ExpressRequest, res: Response) {
  try {
    const { adId } = req.params;
    const { date_preset = 'last_30d' } = req.query;

    console.log(`🔍 [ADMIN] getAdDetailsForAdmin called with adId: ${adId}`);

    if (!adId) {
      console.error(' [ADMIN] Ad ID is missing');
      return res.status(400).json({
        success: false,
        message: 'Ad ID is required'
      });
    }

    // Récupérer le userId du propriétaire de l'annonce depuis stop_loss_settings
    console.log(`🔍 [ADMIN] Fetching stop-loss config for adId: ${adId}`);
    const { data: stopLossConfig, error: configError } = await supabase
      .from('stop_loss_settings')
      .select('user_id')
      .eq('ad_id', adId)
      .single();

    if (configError) {
      console.error(`❌ [ADMIN] Error fetching stop-loss config:`, configError);
      return res.status(404).json({
        success: false,
        message: `Stop-loss configuration not found for this ad: ${configError.message}`
      });
    }

    if (!stopLossConfig) {
      console.error(`❌ [ADMIN] No stop-loss config found for adId: ${adId}`);
      return res.status(404).json({
        success: false,
        message: 'Stop-loss configuration not found for this ad'
      });
    }

    const ownerUserId = (stopLossConfig as any)?.user_id;
    console.log(`✅ [ADMIN] Found owner userId: ${ownerUserId}`);

    // Récupérer le token Facebook du propriétaire
    console.log(`🔍 [ADMIN] Fetching Facebook token for userId: ${ownerUserId}`);
    let tokenRow;
    try {
      tokenRow = await getFacebookToken(ownerUserId);
      console.log(`✅ [ADMIN] Facebook token retrieved successfully`);
      console.log(`✅ [ADMIN] Token details:`, {
        id: tokenRow.id,
        userId: tokenRow.userId,
        tokenLength: tokenRow.token?.length || 0,
        hasToken: !!tokenRow.token,
        tokenPreview: tokenRow.token ? `${tokenRow.token.substring(0, 10)}...` : 'null'
      });
    } catch (tokenError: any) {
      console.error(`❌ [ADMIN] Error fetching Facebook token:`, tokenError);
      console.error(`❌ [ADMIN] Token error details:`, {
        message: tokenError.message,
        stack: tokenError.stack
      });
      
      // Message d'erreur plus descriptif pour l'utilisateur
      return res.status(404).json({
        success: false,
        message: `Facebook token not found for ad owner. The user (${ownerUserId}) has not connected their Facebook account or the token has expired. Please ask the user to reconnect their Facebook account.`,
        details: {
          adId: adId,
          ownerUserId: ownerUserId,
          error: tokenError.message
        }
      });
    }

    if (!tokenRow || !tokenRow.token) {
      console.error(`❌ [ADMIN] Token row is null or token is missing`);
      return res.status(404).json({
        success: false,
        message: `Facebook token is missing or invalid for user ${ownerUserId}. The user needs to reconnect their Facebook account.`,
        details: {
          adId: adId,
          ownerUserId: ownerUserId
        }
      });
    }

    // Récupérer les détails de base de l'ad
    console.log(`🔍 [ADMIN] Fetching ad details from Facebook Graph API for adId: ${adId}`);
    // Récupérer aussi effective_status pour avoir le statut réel (prend en compte campagne/adset)
    const endpoint = `${adId}?fields=id,name,status,effective_status,created_time,updated_time,adset_id,campaign_id,creative{id,name,title,body,call_to_action_type,image_url,video_id,thumbnail_url,link_url,object_story_spec}`;
    const adDetails = await fetchFbGraph(tokenRow.token, endpoint);
    
    // Normaliser le statut (uniquement basé sur le statut de l'ad, indépendant de campagne/adset)
    const normalizedStatus = adDetails.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
    adDetails.status = normalizedStatus;
    
    console.log('✅ [ADMIN] Ad basic details retrieved:', {
      id: adDetails.id,
      name: adDetails.name,
      status_from_facebook: adDetails.status,
      normalized_status: normalizedStatus,
      hasCreative: !!adDetails.creative
    });

    // Si la creative a un video_id, récupérer l'URL de la vidéo
    if (adDetails.creative?.video_id) {
      try {
        const videoEndpoint = `${adDetails.creative.video_id}?fields=source,picture`;
        const videoDetails = await fetchFbGraph(tokenRow.token, videoEndpoint);
        if (videoDetails.source) {
          adDetails.creative.video_url = videoDetails.source;
        }
        if (videoDetails.picture && !adDetails.creative.thumbnail_url) {
          adDetails.creative.thumbnail_url = videoDetails.picture;
        }
      } catch (videoError: any) {
        console.log('⚠️ [ADMIN] Could not fetch video URL:', videoError.message);
      }
    }

    // Récupérer les métriques de l'ad
    let adMetrics = {};
    try {
      const insightsEndpoint = `${adId}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions,conversion_values&date_preset=${date_preset}`;
      const insights = await fetchFbGraph(tokenRow.token, insightsEndpoint);
      const insightData = insights.data?.[0] || {};
      console.log('🔍 [ADMIN] Insight data:', insightData);
      
      adMetrics = {
        spend: parseFloat(insightData.spend || 0),
        impressions: parseInt(insightData.impressions || 0),
        clicks: parseInt(insightData.clicks || 0),
        reach: parseInt(insightData.reach || 0),
        conversions: parseFloat(insightData.conversions || insightData.conversion_values || 0),
        ctr: parseFloat(insightData.ctr || 0),
        cpc: parseFloat(insightData.cpc || 0),
        cpm: parseFloat(insightData.cpm || 0),
        frequency: parseFloat(insightData.frequency || 0),
        conversion_rate: insightData.clicks > 0 ? (parseFloat(insightData.conversions || insightData.conversion_values || 0) / insightData.clicks) * 100 : 0
      };
      console.log('🔍 [ADMIN] Ad metrics:', adMetrics);
    } catch (insightsError: any) {
      console.log('⚠️ [ADMIN] Error fetching ad insights:', insightsError.message);
      // Utiliser des valeurs par défaut en cas d'erreur
      adMetrics = {
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        conversions: 0,
        ctr: 0,
        cpc: 0,
        cpm: 0,
        frequency: 0,
        conversion_rate: 0
      };
    }

    // Combiner les détails de base avec les métriques
    const combinedData = {
      ...adDetails,
      ...adMetrics
    };

    console.log('🔍 [ADMIN] Combined ad data:', combinedData);

    return res.json({
      success: true,
      data: combinedData,
      message: "Ad details retrieved successfully"
    });

  } catch (error: any) {
    console.error(`❌ [ADMIN] Error fetching ad details for ${req.params.adId}:`, error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
      details: error.response?.data || null
    });
  }
}



/**
 * Mettre à jour la configuration batch d'un utilisateur
 */
export async function updateUserBatchConfig(req: ExpressRequest, res: Response) {
  try {
    const { userId } = req.params;
    const { batch_interval_ms, enabled } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const result = await AdminSystemSettingsService.updateUserBatchConfig(userId, {
      batch_interval_ms,
      enabled
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || 'Failed to update user batch config'
      });
    }

    return res.json({
      success: true,
      message: 'User batch configuration updated successfully'
    });
  } catch (error: any) {
    console.error('❌ Error in updateUserBatchConfig:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Supprimer un utilisateur (DELETE)
 */
export async function deleteUser(req: ExpressRequest, res: Response) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Empêcher de supprimer soi-même
    if (req.user?.id === userId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account'
      });
    }

    console.log(`🗑️ [ADMIN] Attempting to delete user: ${userId}`);

    // Obtenir le client Supabase Admin
    const supabaseAdmin = getSupabaseAdminClient();

    // Supprimer l'utilisateur via Supabase Auth Admin API
    const { data: deleteData, error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (deleteError) {
      console.error('❌ Error deleting user from auth:', deleteError);
      return res.status(500).json({
        success: false,
        message: `Failed to delete user: ${deleteError.message}`
      });
    }

    // Supprimer les données associées dans public schema (optionnel)
    // Supprimer les rôles
    await supabase.from('user_roles').delete().eq('user_id', userId);
    
    // Supprimer les tokens d'accès
    await supabase.from('access_tokens').delete().eq('userId', userId);
    
    // Supprimer les configurations stop-loss
    await supabase.from('stop_loss_settings').delete().eq('user_id', userId);
    
    // Supprimer les configurations batch
    await supabase.from('user_batch_config').delete().eq('user_id', userId);

    console.log(`✅ [ADMIN] User ${userId} deleted successfully`);

    return res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error: any) {
    console.error('❌ Error in deleteUser:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Désactiver/Activer un utilisateur (empêcher la connexion)
 */
export async function toggleUserStatus(req: ExpressRequest, res: Response) {
  try {
    const { userId } = req.params;
    const { disabled } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    if (typeof disabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'disabled field (boolean) is required'
      });
    }

    // Empêcher de désactiver soi-même
    if (req.user?.id === userId && disabled) {
      return res.status(400).json({
        success: false,
        message: 'You cannot disable your own account'
      });
    }

    console.log(`🔒 [ADMIN] ${disabled ? 'Disabling' : 'Enabling'} user: ${userId}`);

    // Obtenir le client Supabase Admin
    const supabaseAdmin = getSupabaseAdminClient();

    // Mettre à jour le statut de l'utilisateur
    // Utiliser ban_user pour désactiver (empêche la connexion)
    const { data: updateData, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      {
        ban_duration: disabled ? '876000h' : '0h' // 876000h = ~100 ans (effectivement permanent), 0h = non banni
      }
    );

    if (updateError) {
      console.error('❌ Error updating user status:', updateError);
      return res.status(500).json({
        success: false,
        message: `Failed to ${disabled ? 'disable' : 'enable'} user: ${updateError.message}`
      });
    }

    console.log(`✅ [ADMIN] User ${userId} ${disabled ? 'disabled' : 'enabled'} successfully`);

    return res.json({
      success: true,
      message: `User ${disabled ? 'disabled' : 'enabled'} successfully`,
      data: {
        user_id: userId,
        disabled: disabled
      }
    });
  } catch (error: any) {
    console.error('❌ Error in toggleUserStatus:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Réinitialiser le mot de passe d'un utilisateur (envoie un email de réinitialisation)
 */
export async function resetUserPassword(req: ExpressRequest, res: Response) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    console.log(`🔑 [ADMIN] Attempting to reset password for user: ${userId}`);

    // Obtenir le client Supabase Admin
    const supabaseAdmin = getSupabaseAdminClient();

    // Récupérer les informations de l'utilisateur pour obtenir son email
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (userError || !userData?.user) {
      console.error('❌ Error fetching user:', userError);
      return res.status(404).json({
        success: false,
        message: `User not found: ${userError?.message || 'Unknown error'}`
      });
    }

    const userEmail = userData.user.email;

    if (!userEmail) {
      return res.status(400).json({
        success: false,
        message: 'User does not have an email address. Cannot send password reset email.'
      });
    }

    // Méthode 1 : Utiliser l'API REST Supabase pour envoyer l'email de réinitialisation
    // Cette méthode ENVOIE RÉELLEMENT l'email (contrairement à generateLink qui peut juste générer le lien)
    // ⚠️ IMPORTANT: Utilise UNIQUEMENT les variables d'environnement, pas de valeurs par défaut
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl) {
      console.error('❌ SUPABASE_URL is missing');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error: SUPABASE_URL is not set. Please set it in your .env file or Vercel environment variables.'
      });
    }
    
    if (!supabaseServiceKey) {
      console.error('❌ SUPABASE_SERVICE_ROLE_KEY is missing');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error: SUPABASE_SERVICE_ROLE_KEY is not set. Please set it in your .env file or Vercel environment variables.'
      });
    }

    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
      console.error('❌ FRONTEND_URL is missing');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error: FRONTEND_URL is not set. Please set it in your .env file or Vercel environment variables.'
      });
    }

    const redirectTo = `${frontendUrl}/auth/reset-password`;
    
    console.log(`📧 [ADMIN] Sending password reset email to ${userEmail} via Supabase REST API`);
    
    // Appel direct à l'API REST Supabase pour réinitialiser le mot de passe
    // IMPORTANT: L'API /auth/v1/recover nécessite l'anon key, pas le service role key
    // pour déclencher l'envoi d'email (sécurité Supabase)
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseAnonKey) {
      console.error('❌ SUPABASE_ANON_KEY is missing for email sending');
      // Fallback to generateLink
      const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: userEmail,
        options: { redirectTo: redirectTo }
      });
      
      return res.json({
        success: true,
        message: 'Password reset link generated. Email requires ANON_KEY configuration.',
        data: {
          user_id: userId,
          email: userEmail,
          reset_link: linkData?.properties?.action_link || null
        },
        warning: 'SUPABASE_ANON_KEY required for email sending'
      });
    }

    // Utiliser l'anon key pour déclencher l'envoi d'email
    // L'API /auth/v1/recover avec anon key déclenche réellement l'envoi
    try {
      console.log(`📧 [ADMIN] Using ANON_KEY to send recovery email via /auth/v1/recover`);
      
      const recoverResponse = await fetch(`${supabaseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`
        },
        body: JSON.stringify({
          email: userEmail,
          redirect_to: redirectTo
        })
      });

      const recoverData = await recoverResponse.json();
      
      console.log(`📧 [ADMIN] Recover API response:`, {
        status: recoverResponse.status,
        ok: recoverResponse.ok,
        data: recoverData
      });

      if (!recoverResponse.ok) {
        console.error('❌ Error sending password reset email via REST API:', recoverData);
        
        // Fallback : Utiliser generateLink pour obtenir le lien même si l'email n'est pas envoyé
        console.log('⚠️ [ADMIN] REST API failed, falling back to generateLink');
        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery',
          email: userEmail,
          options: {
            redirectTo: redirectTo
          }
        });

        if (linkError) {
          console.error('❌ Error generating password reset link:', linkError);
          return res.status(500).json({
            success: false,
            message: `Failed to send password reset email: ${recoverData?.error_description || linkError.message || 'Unknown error'}`
          });
        }

        const resetLink = linkData?.properties?.action_link || null;
        
        return res.json({
          success: true,
          message: 'Password reset link generated. Email may not have been sent. Please check SMTP configuration.',
          data: {
            user_id: userId,
            email: userEmail,
            reset_link: resetLink
          },
          warning: 'Email may not have been sent. SMTP configuration should be checked in Supabase Dashboard.'
        });
      }

      // Succès : l'email devrait être envoyé
      console.log(`✅ [ADMIN] Password reset email sent successfully to ${userEmail}`);
      
      // Générer aussi le lien au cas où l'utilisateur ne recevrait pas l'email
      const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: userEmail,
        options: {
          redirectTo: redirectTo
        }
      });

      const resetLink = linkData?.properties?.action_link || null;
      
      if (resetLink) {
        console.log(`📧 [ADMIN] Reset link generated as backup: ${resetLink}`);
      }

      return res.json({
        success: true,
        message: 'Password reset email sent successfully. Please check your email inbox and spam folder.',
        data: {
          user_id: userId,
          email: userEmail,
          reset_link: resetLink // Lien disponible en backup si l'email n'est pas reçu
        }
      });
    } catch (error: any) {
      console.error('❌ Error in resetUserPassword:', error);
      
      // En cas d'erreur, essayer quand même generateLink pour avoir le lien
      try {
        const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery',
          email: userEmail,
          options: {
            redirectTo: redirectTo
          }
        });
        
        const resetLink = linkData?.properties?.action_link || null;
        
        return res.status(500).json({
          success: false,
          message: `Failed to send password reset email: ${error.message || 'Unknown error'}`,
          data: {
            user_id: userId,
            email: userEmail,
            reset_link: resetLink // Lien disponible même en cas d'erreur
          },
          error: error.message
        });
      } catch (fallbackError: any) {
        return res.status(500).json({
          success: false,
          message: `Failed to send password reset email: ${error.message || 'Unknown error'}`
        });
      }
    }
  } catch (error: any) {
    console.error('❌ Error in resetUserPassword (outer catch):', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer l'historique des stop-loss de tous les utilisateurs (Admin seulement)
 */
export async function getStopLossHistory(req: ExpressRequest, res: Response) {
  try {
    const { userId, limit = 100, offset = 0 } = req.query;
    const supabaseAdmin = getSupabaseAdminClient();

    console.log('🔍 [ADMIN] Fetching stop-loss history (triggered events + configurations)', { userId, limit, offset });

    // Récupérer les logs de déclenchement (STOP_LOSS_TRIGGERED) - les événements réels
    let logsQuery = supabaseAdmin
      .from('logs')
      .select('*')
      .eq('action', 'STOP_LOSS_TRIGGERED')
      .order('created_at', { ascending: false });

    if (userId) {
      logsQuery = logsQuery.or(`userId.eq.${userId},user_id.eq.${userId}`);
    }

    const { data: logs, error: logsError } = await logsQuery;

    // Récupérer TOUTES les configurations stop-loss (actives et inactives) pour visibilité permanente
    let configsQuery = supabaseAdmin
      .from('stop_loss_settings')
      .select('*')
      .order('created_at', { ascending: false });

    if (userId) {
      configsQuery = configsQuery.eq('user_id', userId);
    }

    const { data: configs, error: configsError } = await configsQuery;

    if (logsError) {
      console.error('❌ Error fetching stop-loss logs:', logsError);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch stop-loss history"
      });
    }

    if (configsError) {
      console.error('❌ Error fetching stop-loss configurations:', configsError);
      // Ne pas échouer complètement, continuer avec les logs seulement
    }

    // Récupérer les informations utilisateur (nécessaire pour enrichir les configurations et les logs)
    const { data: allUsers, error: usersError } = await supabaseAdmin.rpc('get_all_users');
    const usersMap = new Map();
    if (allUsers && Array.isArray(allUsers)) {
      allUsers.forEach((user: any) => {
        usersMap.set(user.id, {
          email: user.email || null,
          name: user.user_metadata?.full_name || user.user_metadata?.name || null,
          role: user.role || 'user'
        });
      });
    }

    // Récupérer la configuration du batch pour les informations d'intervalle (au moment du déclenchement)
    let batchConfig: any = null;
    try {
      const { data: batchData } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'stop_loss_batch')
        .single();
      
      if (batchData) {
        batchConfig = (batchData as any).value;
      }
    } catch (error) {
      console.warn('⚠️ Could not fetch batch config:', error);
    }

    // Enrichir les configurations stop-loss
    const enrichedConfigs = (configs || []).map((config: any) => {
      const userInfo = usersMap.get(config.user_id) || { email: null, name: null };
      
      return {
        id: `config-${config.id}`, // Préfixe pour différencier des logs
        type: 'configuration' as const,
        userId: config.user_id,
        userEmail: userInfo.email,
        userName: userInfo.name,
        adId: config.ad_id,
        adName: config.ad_name || 'Unknown',
        accountId: config.account_id,
        // Données de configuration
        enabled: config.enabled,
        costPerResultThreshold: config.cost_per_result_threshold,
        zeroResultsSpendThreshold: config.zero_results_spend_threshold,
        cprEnabled: config.cpr_enabled !== false,
        zeroResultsEnabled: config.zero_results_enabled !== false,
        createdAt: config.created_at,
        updatedAt: config.updated_at,
        // Pas de données de déclenchement pour les configurations
        reason: null,
        spend: null,
        results: null,
        threshold: null,
        actualValue: null,
        triggeredAt: null,
        triggeredBy: null,
        details: {
          configId: config.id,
          enabled: config.enabled,
          costPerResultThreshold: config.cost_per_result_threshold,
          zeroResultsSpendThreshold: config.zero_results_spend_threshold,
          cprEnabled: config.cpr_enabled,
          zeroResultsEnabled: config.zero_results_enabled
        }
      };
    });

    // Enrichir les logs de déclenchement avec toutes les informations nécessaires
    const enrichedLogs = await Promise.all(
      (logs || []).map(async (log: any) => {
        try {
          const logUserId = log.userId || log.user_id;
          const userInfo = usersMap.get(logUserId) || { email: null, name: null };
          
          // Récupérer le nom de l'ad depuis stop_loss_settings si disponible
          // Cela permet d'avoir le nom même si la config a été supprimée après
          let adName = null;
          let accountId = null;
          if (log.details?.adId || log.details?.ad_id) {
            const adId = log.details?.adId || log.details?.ad_id;
            const { data: stopLossData } = await supabaseAdmin
              .from('stop_loss_settings')
              .select('ad_name, account_id')
              .eq('ad_id', adId)
              .eq('user_id', logUserId)
              .limit(1)
              .maybeSingle();
            
            if (stopLossData) {
              adName = (stopLossData as any).ad_name;
              accountId = (stopLossData as any).account_id;
            }
          }

          return {
            id: log.id,
            type: 'triggered', // Seul type dans l'historique : les événements déclenchés
            userId: logUserId,
            userEmail: userInfo.email,
            userName: userInfo.name,
            adId: log.details?.adId || log.details?.ad_id,
            adName: adName || log.details?.adName || log.details?.ad_name || 'Unknown',
            accountId: accountId || log.details?.accountId || log.details?.account_id,
            reason: log.details?.reason || 'Unknown reason',
            spend: log.details?.spend || 0,
            results: log.details?.results || 0,
            threshold: log.details?.threshold,
            actualValue: log.details?.actualValue || log.details?.actual_value,
            triggeredAt: log.details?.triggeredAt || log.details?.triggered_at || log.created_at,
            triggeredBy: log.details?.triggeredBy || log.details?.triggered_by || 'automatic',
            createdAt: log.created_at,
            details: log.details,
            // Informations batch au moment du déclenchement
            batchInterval: batchConfig?.batch_interval_ms ? `${batchConfig.batch_interval_ms / 1000}s` : '60s',
            batchEnabled: batchConfig?.enabled !== false
          };
        } catch (err) {
          console.error('Error enriching log:', err);
          const logUserId = log.userId || log.user_id;
          const userInfo = usersMap.get(logUserId) || { email: null, name: null };
          return {
            id: log.id,
            type: 'triggered',
            userId: logUserId,
            userEmail: userInfo.email,
            userName: userInfo.name,
            adId: log.details?.adId || log.details?.ad_id,
            adName: log.details?.adName || log.details?.ad_name || 'Unknown',
            accountId: log.details?.accountId || log.details?.account_id,
            reason: log.details?.reason || 'Unknown reason',
            spend: log.details?.spend || 0,
            results: log.details?.results || 0,
            threshold: log.details?.threshold,
            actualValue: log.details?.actualValue || log.details?.actual_value,
            triggeredAt: log.details?.triggeredAt || log.details?.triggered_at || log.created_at,
            triggeredBy: log.details?.triggeredBy || log.details?.triggered_by || 'automatic',
            createdAt: log.created_at,
            details: log.details,
            batchInterval: batchConfig?.batch_interval_ms ? `${batchConfig.batch_interval_ms / 1000}s` : '60s',
            batchEnabled: batchConfig?.enabled !== false
          };
        }
      })
    );

    // Combiner les configurations et les événements déclenchés
    const allHistory = [...enrichedConfigs, ...enrichedLogs];
    
    // Trier par date de création (plus récent en premier)
    allHistory.sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA; // Décroissant
    });

    // Compter les statistiques
    const triggeredCount = enrichedLogs.length;
    const activeConfigsCount = enrichedConfigs.filter(c => c.enabled).length;
    const inactiveConfigsCount = enrichedConfigs.filter(c => !c.enabled).length;
    const totalCount = allHistory.length;

    // Paginer le résultat
    const paginated = allHistory.slice(
      parseInt(offset as string),
      parseInt(offset as string) + parseInt(limit as string)
    );
    
    console.log(`✅ [ADMIN] Found ${triggeredCount} triggered events, ${enrichedConfigs.length} configurations (${activeConfigsCount} active, ${inactiveConfigsCount} inactive), total: ${totalCount}`);

    return res.json({
      success: true,
      data: paginated,
      pagination: {
        total: totalCount,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
        hasMore: totalCount > parseInt(offset as string) + parseInt(limit as string)
      },
      stats: {
        triggered: triggeredCount,
        configurations: enrichedConfigs.length,
        activeConfigs: activeConfigsCount,
        inactiveConfigs: inactiveConfigsCount,
        total: totalCount
      }
    });

  } catch (error: any) {
    console.error('❌ Error in getStopLossHistory:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Delete stop-loss history entry (Admin only)
 * Can delete both triggered events (logs) and configurations (stop_loss_settings)
 */
export async function deleteStopLossHistoryEntry(req: ExpressRequest, res: Response) {
  try {
    // Vérification supplémentaire : s'assurer que l'utilisateur est bien admin
    // (le middleware requireAdmin devrait déjà avoir vérifié, mais double vérification pour sécurité)
    if (!req.user || !(req.user as any).role || (req.user as any).role !== 'admin') {
      console.error(`❌ [ADMIN] Unauthorized deletion attempt by user: ${req.user?.id || 'unknown'}`);
      return res.status(403).json({
        success: false,
        message: 'Access denied: Only administrators can delete stop-loss history entries'
      });
    }

    const { id, type } = req.params; // id is log id or config id, type is 'triggered' or 'configuration'
    const supabaseAdmin = getSupabaseAdminClient();

    console.log(`🗑️ [ADMIN] Admin user ${req.user.id} deleting stop-loss history entry: ${id}, type: ${type}`);

    // Supprimer soit un événement déclenché (log) soit une configuration (stop_loss_settings)
    if (type === 'configuration') {
      // Extraire l'ID réel de la configuration (enlever le préfixe "config-")
      const configId = id.startsWith('config-') ? id.replace('config-', '') : id;
      
      console.log(`🗑️ [ADMIN] Deleting stop-loss configuration: ${configId}`);
      
      // Delete from stop_loss_settings table
      const { error: deleteError } = await (supabaseAdmin
        .from('stop_loss_settings') as any)
        .delete()
        .eq('id', configId);

      if (deleteError) {
        console.error('❌ Error deleting configuration:', deleteError);
        return res.status(500).json({
          success: false,
          message: `Failed to delete configuration: ${deleteError.message}`
        });
      }

      console.log(`✅ [ADMIN] Configuration ${configId} deleted successfully`);
      return res.json({
        success: true,
        message: 'Configuration deleted successfully'
      });
    }

    if (type !== 'triggered') {
      return res.status(400).json({
        success: false,
        message: 'Invalid type. Only "triggered" or "configuration" entries can be deleted.'
      });
    }

    // Extraire l'ID réel si c'est un ID avec préfixe (pour les logs, l'ID est directement l'ID du log)
    const logId = id.startsWith('config-') ? id.replace('config-', '') : id;
    
    // Delete from logs table
    const { error: deleteError } = await (supabaseAdmin
      .from('logs') as any)
      .delete()
      .eq('id', logId)
      .eq('action', 'STOP_LOSS_TRIGGERED');

    if (deleteError) {
      console.error('❌ Error deleting log entry:', deleteError);
      return res.status(500).json({
        success: false,
        message: `Failed to delete log entry: ${deleteError.message}`
      });
    }

    console.log(`✅ [ADMIN] Log entry ${id} deleted successfully`);

    return res.json({
      success: true,
      message: 'Entry deleted successfully'
    });

  } catch (error: any) {
    console.error('❌ Error in deleteStopLossHistoryEntry:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}

/**
 * Récupérer l'historique détaillé d'une ad spécifique (Admin seulement)
 * Retourne toutes les désactivations (STOP_LOSS_TRIGGERED) pour cette ad avec analytics
 */
export async function getAdStopLossAnalytics(req: ExpressRequest, res: Response) {
  try {
    const { userId, adId } = req.params;
    const supabaseAdmin = getSupabaseAdminClient();

    if (!userId || !adId) {
      return res.status(400).json({
        success: false,
        message: 'userId and adId are required'
      });
    }

    console.log(`🔍 [ADMIN] Fetching stop-loss analytics for ad ${adId} (user: ${userId})`);

    // Récupérer tous les événements STOP_LOSS_TRIGGERED pour cette ad spécifique
    // Utiliser le filtrage JSON pour adId dans details
    let adLogs: any[] = [];
    let logsError: any = null;

    // Essayer d'abord avec user_id (format le plus courant)
    const { data: logsByUser_id, error: error1 } = await supabaseAdmin
      .from('logs')
      .select('*')
      .eq('action', 'STOP_LOSS_TRIGGERED')
      .eq('user_id', userId)
      .eq('details->>adId', adId)
      .order('created_at', { ascending: false });

    if (!error1 && logsByUser_id) {
      adLogs = logsByUser_id;
    } else {
      // Essayer avec userId
      const { data: logsByUserId, error: error2 } = await supabaseAdmin
        .from('logs')
        .select('*')
        .eq('action', 'STOP_LOSS_TRIGGERED')
        .eq('userId', userId)
        .eq('details->>adId', adId)
        .order('created_at', { ascending: false });

      if (!error2 && logsByUserId) {
        adLogs = logsByUserId;
      } else {
        // Si le filtrage JSON ne fonctionne pas, récupérer tous les logs et filtrer en JavaScript
        console.warn('⚠️ JSON filtering not working, trying fallback method');
        const { data: allLogs, error: error3 } = await supabaseAdmin
          .from('logs')
          .select('*')
          .eq('action', 'STOP_LOSS_TRIGGERED')
          .or(`user_id.eq.${userId},userId.eq.${userId}`)
          .order('created_at', { ascending: false });

        if (!error3 && allLogs) {
          // Filtrer en JavaScript
          adLogs = allLogs.filter((log: any) => {
            const logAdId = log.details?.adId || log.details?.ad_id;
            return logAdId === adId;
          });
        } else {
          logsError = error3 || error2 || error1;
        }
      }
    }

    if (logsError) {
      console.error('❌ Error fetching stop-loss logs:', logsError);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch stop-loss analytics"
      });
    }

    // Récupérer les informations utilisateur
    let userInfo = { email: null, name: null };
    try {
      // Essayer d'abord avec la fonction RPC
      const { data: allUsers, error: usersError } = await supabaseAdmin.rpc('get_all_users');
      if (!usersError && allUsers && Array.isArray(allUsers)) {
        const usersMap = new Map();
        allUsers.forEach((user: any) => {
          usersMap.set(user.id, {
            email: user.email || null,
            name: user.user_metadata?.full_name || user.user_metadata?.name || null,
            role: user.role || 'user'
          });
        });
        userInfo = usersMap.get(userId) || { email: null, name: null };
      } else {
        // Si la fonction RPC n'existe pas, essayer de récupérer directement depuis auth.users
        console.warn('⚠️ RPC get_all_users not available, trying direct user fetch');
        try {
          const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
          if (!userError && userData?.user) {
            userInfo = {
              email: userData.user.email || null,
              name: userData.user.user_metadata?.full_name || userData.user.user_metadata?.name || null
            };
          }
        } catch (authError) {
          console.warn('⚠️ Could not fetch user info:', authError);
        }
      }
    } catch (error) {
      console.warn('⚠️ Error fetching user info, continuing without it:', error);
    }

    // Enrichir les logs avec toutes les informations
    const enrichedLogs = adLogs.map((log: any) => {
      const triggeredAt = log.details?.triggeredAt || log.details?.triggered_at || log.created_at;
      return {
        id: log.id,
        triggeredAt: triggeredAt,
        createdAt: log.created_at,
        reason: log.details?.reason || 'Unknown reason',
        spend: log.details?.spend || 0,
        results: log.details?.results || 0,
        threshold: log.details?.threshold,
        actualValue: log.details?.actualValue || log.details?.actual_value,
        triggeredBy: log.details?.triggeredBy || log.details?.triggered_by || 'automatic',
        costPerResult: log.details?.cost_per_result || (log.details?.results > 0 ? log.details?.spend / log.details?.results : null),
        details: log.details
      };
    });

    // Calculer les statistiques
    const stats = {
      totalDeactivations: enrichedLogs.length,
      totalSpent: enrichedLogs.reduce((sum, log) => sum + (log.spend || 0), 0),
      totalResults: enrichedLogs.reduce((sum, log) => sum + (log.results || 0), 0),
      averageSpend: enrichedLogs.length > 0 ? enrichedLogs.reduce((sum, log) => sum + (log.spend || 0), 0) / enrichedLogs.length : 0,
      averageResults: enrichedLogs.length > 0 ? enrichedLogs.reduce((sum, log) => sum + (log.results || 0), 0) / enrichedLogs.length : 0,
      firstDeactivation: enrichedLogs.length > 0 ? enrichedLogs[enrichedLogs.length - 1].triggeredAt : null,
      lastDeactivation: enrichedLogs.length > 0 ? enrichedLogs[0].triggeredAt : null,
      byReason: enrichedLogs.reduce((acc: any, log) => {
        const reason = log.reason || 'Unknown';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
      byHour: enrichedLogs.reduce((acc: any, log) => {
        const date = new Date(log.triggeredAt);
        const hour = date.getHours();
        acc[hour] = (acc[hour] || 0) + 1;
        return acc;
      }, {}),
      byDay: enrichedLogs.reduce((acc: any, log) => {
        const date = new Date(log.triggeredAt);
        const day = date.toISOString().split('T')[0];
        acc[day] = (acc[day] || 0) + 1;
        return acc;
      }, {})
    };

    // Récupérer le nom de l'ad depuis stop_loss_settings
    let adName = 'Unknown';
    const { data: stopLossConfig } = await supabaseAdmin
      .from('stop_loss_settings')
      .select('ad_name')
      .eq('user_id', userId)
      .eq('ad_id', adId)
      .limit(1)
      .maybeSingle();

    if (stopLossConfig) {
      adName = (stopLossConfig as any).ad_name || adId;
    }

    return res.json({
      success: true,
      data: {
        adId,
        adName,
        userId,
        userEmail: userInfo.email,
        userName: userInfo.name,
        events: enrichedLogs,
        stats
      }
    });

  } catch (error: any) {
    console.error('❌ Error in getAdStopLossAnalytics:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
}