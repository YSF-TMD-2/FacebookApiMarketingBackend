import { createClient } from '@supabase/supabase-js';

// Configuration Supabase optimisée pour le backend
const supabaseUrl = process.env.SUPABASE_URL || 'https://qjakxxkgtfdsjglwisbf.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqYWt4eGtndGZkc2pnbHdpc2JmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk5ODYwNTcsImV4cCI6MjA3NTU2MjA1N30.r_1Kgepi8fkzKAIz44m1ND4R1iTtPL-Lw3TiLvkUzh8';

// Types pour la base de données
export interface Database {
  public: {
    Tables: {
      access_tokens: {
        Row: {
          id: number;
          userId: string;
          token: string;
          scopes: string | null;
          meta: any | null;
        };
        Insert: {
          id?: number;
          userId: string;
          token: string;
          scopes?: string | null;
          meta?: any | null;
        };
        Update: {
          id?: number;
          userId?: string;
          token?: string;
          scopes?: string | null;
          meta?: any | null;
        };
      };
      logs: {
        Row: {
          id: number;
          userId: string;
          action: string;
          details: any | null;
          ip: string | null;
          userAgent: string | null;
        };
        Insert: {
          id?: number;
          userId: string;
          action: string;
          details?: any | null;
          ip?: string | null;
          userAgent?: string | null;
        };
        Update: {
          id?: number;
          userId?: string;
          action?: string;
          details?: any | null;
          ip?: string | null;
          userAgent?: string | null;
        };
      };
    };
  };
}

// Créer le client Supabase avec configuration optimisée
export const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false, // Pas de persistance côté serveur
    detectSessionInUrl: false
  },
  db: {
    schema: 'public'
  },
  global: {
    headers: {
      'X-Client-Info': 'facebook-api-backend'
    },
    fetch: (url, options = {}) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      return fetch(url, {
        ...options,
        signal: controller.signal
      }).finally(() => {
        clearTimeout(timeoutId);
      });
    }
  }
});

// Types pour TypeScript - Supabase Auth
export interface UserProfile {
  id: string;
  email: string;
  name: string;
  email_confirmed: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user: UserProfile;
}
