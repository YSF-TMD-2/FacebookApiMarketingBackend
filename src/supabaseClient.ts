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
          user_id: string;
          token: string;
          scopes: string | null;
          meta: any | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          user_id: string;
          token: string;
          scopes?: string | null;
          meta?: any | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string;
          token?: string;
          scopes?: string | null;
          meta?: any | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      logs: {
        Row: {
          id: number;
          user_id: string;
          action: string;
          details: any | null;
          ip: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          user_id: string;
          action: string;
          details?: any | null;
          ip?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string;
          action?: string;
          details?: any | null;
          ip?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
      };
      thresholds: {
        Row: {
          id: number;
          user_id: string;
          cost_per_result_threshold: number;
          zero_results_spend_threshold: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          user_id: string;
          cost_per_result_threshold: number;
          zero_results_spend_threshold: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string;
          cost_per_result_threshold?: number;
          zero_results_spend_threshold?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      stop_loss_settings: {
        Row: {
          id: number;
          user_id: string;
          ad_id: string;
          account_id: string;
          ad_name: string | null;
          enabled: boolean;
          cost_per_result_threshold: number | null;
          zero_results_spend_threshold: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          user_id: string;
          ad_id: string;
          account_id: string;
          ad_name?: string | null;
          enabled?: boolean;
          cost_per_result_threshold?: number | null;
          zero_results_spend_threshold?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string;
          ad_id?: string;
          account_id?: string;
          ad_name?: string | null;
          enabled?: boolean;
          cost_per_result_threshold?: number | null;
          zero_results_spend_threshold?: number | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      notifications: {
        Row: {
          id: number;
          user_id: string;
          type: string;
          title: string;
          message: string;
          data: any | null;
          is_read: boolean;
          created_at: string;
        };
        Insert: {
          id?: number;
          user_id: string;
          type: string;
          title: string;
          message: string;
          data?: any | null;
          is_read?: boolean;
          created_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string;
          type?: string;
          title?: string;
          message?: string;
          data?: any | null;
          is_read?: boolean;
          created_at?: string;
        };
      };
      ads: {
        Row: {
          id: string;
          user_id: string;
          account_id: string;
          name: string | null;
          status: string;
          spend: number;
          results: number;
          stop_loss_triggered: boolean;
          stop_loss_date: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          account_id: string;
          name?: string | null;
          status?: string;
          spend?: number;
          results?: number;
          stop_loss_triggered?: boolean;
          stop_loss_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          account_id?: string;
          name?: string | null;
          status?: string;
          spend?: number;
          results?: number;
          stop_loss_triggered?: boolean;
          stop_loss_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Functions: {
      create_stop_loss_event: {
        Args: {
          p_user_id: string;
          p_ad_id: string;
          p_account_id: string;
          p_ad_name: string;
          p_event_type: string;
          p_spend: number;
          p_results: number;
          p_cost_per_result: number;
          p_threshold_type: string;
          p_threshold_value: number;
          p_metadata: any;
        };
        Returns: void;
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

// Types pour les actions de log
export type LogAction = 
  | 'USER_LOGIN'
  | 'USER_LOGOUT'
  | 'USER_REGISTER'
  | 'TOKEN_SAVED'
  | 'TOKEN_UPDATED'
  | 'TOKEN_DELETED'
  | 'AD_CREATED'
  | 'AD_UPDATED'
  | 'AD_DELETED'
  | 'AD_PAUSED'
  | 'AD_RESUMED'
  | 'STOP_LOSS_CONFIG'
  | 'STOP_LOSS_DELETED'
  | 'STOP_LOSS_TRIGGERED'
  | 'THRESHOLDS_UPDATED'
  | 'THRESHOLDS_RESET'
  | 'API_CALL'
  | 'ERROR_OCCURRED';
