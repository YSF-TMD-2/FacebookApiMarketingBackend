import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { Request as ExpressRequest } from '../types/express.js';

// Cache pour le client Supabase (lazy initialization)
// IMPORTANT: Cette fonction est appelée après que dotenv.config() soit exécuté
let supabaseAdminClient: ReturnType<typeof createClient> | null = null;
let isInitialized = false;

export function getSupabaseAdminClient() {
  if (supabaseAdminClient && isInitialized) {
    return supabaseAdminClient;
  }

  const url = process.env.SUPABASE_URL || 'https://qjakxxkgtfdsjglwisbf.supabase.co';
  
  // PRIORITÉ: service_role_key > anon_key > fallback
  // Le service_role_key permet de contourner RLS, c'est CRUCIAL pour le backend
  const key = 
    process.env.SUPABASE_SERVICE_ROLE_KEY || 
    process.env.SUPABASE_ANON_KEY || 
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqYWt4eGtndGZkc2pnbHdpc2JmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk5ODYwNTcsImV4cCI6MjA3NTU2MjA1N30.r_1Kgepi8fkzKAIz44m1ND4R1iTtPL-Lw3TiLvkUzh8';

  // Log de diagnostic (seulement au premier appel)
  if (!isInitialized) {
    console.log('🔧 [ROLE MIDDLEWARE] Initialization:');
    console.log('  - SUPABASE_URL:', url ? '✅ Configuré' : '❌ Manquant');
    console.log('  - SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Configuré (' + process.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 20) + '...)' : '❌ Manquant');
    console.log('  - SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✅ Configuré' : '❌ Manquant');
    console.log('  - Using key type:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role (bypasses RLS) ✅' : process.env.SUPABASE_ANON_KEY ? 'anon (RLS active) ⚠️' : 'fallback (RLS active) ⚠️');
    isInitialized = true;
  }

  supabaseAdminClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return supabaseAdminClient;
}

/**
 * Middleware pour vérifier le rôle de l'utilisateur
 */
export function authorizeRole(allowedRoles: string[]) {
  return async (req: ExpressRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated'
        });
      }

      // Récupérer le rôle de l'utilisateur
      // Utiliser supabaseAdmin (service_role_key) pour contourner RLS côté backend
      console.log('🔍 [ADMIN CHECK] Checking role for user:', req.user.id);
      console.log('🔑 [ADMIN CHECK] Service role key available:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
      console.log('🔑 [ADMIN CHECK] Anon key available:', !!process.env.SUPABASE_ANON_KEY);
      
      // Réinitialiser le client au cas où les env vars ont changé
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_ANON_KEY) {
        console.warn('⚠️ [ADMIN CHECK] Using anon_key - RLS policies may block access!');
        console.warn('💡 [ADMIN CHECK] Consider adding SUPABASE_SERVICE_ROLE_KEY to bypass RLS');
      }
      
      // Obtenir le client Supabase (lazy init pour garantir que dotenv.config() a été appelé)
      const supabaseAdmin = getSupabaseAdminClient();
      
      const { data, error } = await supabaseAdmin
        .from('user_roles')
        .select('role')
        .eq('user_id', req.user.id)
        .maybeSingle(); // Utiliser maybeSingle pour éviter erreur si pas de rôle

      console.log('📊 [ADMIN CHECK] Role query result:', { 
        data, 
        error: error ? {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        } : null,
        userId: req.user.id,
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY
      });

      if (error) {
        console.error('❌ Error fetching user role in backend:', error);
        // Si erreur RLS (500), on assume user par défaut
        if (error.code === '42501' || error.code === 'PGRST116') {
          console.log('ℹ️ RLS error or no role found, defaulting to user');
        }
      }

      if (error || !data) {
        // Par défaut, role = 'user' si pas de rôle défini
        const defaultRole = 'user';
        console.log(`⚠️ [ADMIN CHECK] User has no role or error, defaulting to: ${defaultRole}`);
        console.log(`⚠️ [ADMIN CHECK] Error details:`, error);
        console.log(`⚠️ [ADMIN CHECK] Data:`, data);
        
        if (error && error.code === '42501') {
          console.error('🚨 [ADMIN CHECK] RLS Policy Error - Service role key may not be configured!');
          console.error('💡 [ADMIN CHECK] Solution: Add SUPABASE_SERVICE_ROLE_KEY to backend/.env');
        }
        
        if (allowedRoles.includes(defaultRole)) {
          console.log(`✅ [ADMIN CHECK] Default role '${defaultRole}' is allowed, proceeding...`);
          return next();
        }
        
        console.log(`❌ [ADMIN CHECK] Access denied: Required roles: ${allowedRoles.join(', ')}, User role: ${defaultRole}`);
        return res.status(403).json({
          success: false,
          message: 'Access denied: Insufficient permissions',
          error: error?.message,
          error_code: error?.code,
          user_id: req.user.id,
          required_roles: allowedRoles,
          user_role: defaultRole,
          debug_info: {
            has_error: !!error,
            has_data: !!data,
            using_service_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY
          }
        });
      }

      const userRole = (data as { role: string }).role;
      console.log(`✅ [ADMIN CHECK] User role found: ${userRole}`);

      if (!allowedRoles.includes(userRole)) {
        console.log(`❌ [ADMIN CHECK] Access denied: Required roles: ${allowedRoles.join(', ')}, User role: ${userRole}`);
        return res.status(403).json({
          success: false,
          message: 'Access denied: Insufficient permissions',
          required_roles: allowedRoles,
          user_role: userRole
        });
      }

      console.log(`✅ [ADMIN CHECK] User role '${userRole}' is allowed, proceeding...`);

      // Ajouter le rôle à la requête (extension du type user)
      (req.user as any).role = userRole;
      next();
    } catch (error) {
      console.error('❌ Error in authorizeRole middleware:', error);
      return res.status(500).json({
        success: false,
        message: 'Error checking user permissions'
      });
    }
  };
}

/**
 * Middleware pour vérifier si l'utilisateur est admin
 */
export const requireAdmin = authorizeRole(['admin']);

/**
 * Middleware pour vérifier si l'utilisateur est admin ou user normal
 */
export const requireUser = authorizeRole(['admin', 'user']);


