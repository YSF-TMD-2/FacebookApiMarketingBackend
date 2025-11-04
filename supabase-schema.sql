-- =======================================================
-- SUPABASE SCHEMA — Facebook Ads SaaS Backend
-- =======================================================

-- Table pour stocker les tokens Facebook des utilisateurs
CREATE TABLE access_tokens (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    scopes TEXT, -- ex: "ads_read,ads_management"
    meta JSONB, -- optionnel: données Facebook mises en cache
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table pour les logs d'activité des utilisateurs
CREATE TABLE logs (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    action TEXT NOT NULL, -- ex: "LOGIN", "UPLOAD_TOKEN", "FETCH_ADS", "AD_STATUS_CHANGE", "STOP_LOSS_CONFIG", "SCHEDULE_CREATE"
    details JSONB, -- structure libre: ex. { adAccountId: "123", adsFetched: 25, adId: "456", oldStatus: "PAUSED", newStatus: "ACTIVE" }
    ip TEXT, -- adresse IP utilisateur
    user_agent TEXT, -- user agent du navigateur
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- Index pour optimiser les performances
CREATE INDEX idx_access_tokens_user_id ON access_tokens(user_id);
CREATE INDEX idx_logs_user_id ON logs(user_id);
CREATE INDEX idx_logs_action ON logs(action);
CREATE INDEX idx_logs_created_at ON logs(created_at);

-- RLS (Row Level Security) - Sécurité au niveau des lignes
ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

-- Politiques RLS pour access_tokens
CREATE POLICY "Users can view their own tokens" ON access_tokens
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own tokens" ON access_tokens
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tokens" ON access_tokens
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tokens" ON access_tokens
    FOR DELETE USING (auth.uid() = user_id);

-- Politiques RLS pour logs
CREATE POLICY "Users can view their own logs" ON logs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own logs" ON logs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own logs" ON logs
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own logs" ON logs
    FOR DELETE USING (auth.uid() = user_id);


-- Fonction pour mettre à jour updated_at automatiquement
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger pour access_tokens
CREATE TRIGGER update_access_tokens_updated_at 
    BEFORE UPDATE ON access_tokens 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =======================================================
-- TABLES POUR SYSTÈME STOP-LOSS OPTIMISÉ
-- =======================================================

-- Table pour les rôles utilisateurs (Admin/User)
CREATE TABLE user_roles (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table pour les paramètres système (configuration admin du batch)
CREATE TABLE system_settings (
    id SERIAL PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table pour le suivi des quotas API Meta
CREATE TABLE api_quota_tracking (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id TEXT,
    call_count INTEGER DEFAULT 0,
    quota_usage_percent INTEGER DEFAULT 0,
    last_reset_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table pour les publicités en échec (retry queue)
CREATE TABLE stop_loss_retry_queue (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_id TEXT NOT NULL,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    next_retry_at TIMESTAMP WITH TIME ZONE NOT NULL,
    error_message TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index pour optimiser les performances
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_role ON user_roles(role);
CREATE INDEX idx_system_settings_key ON system_settings(key);
CREATE INDEX idx_api_quota_tracking_user_id ON api_quota_tracking(user_id);
CREATE INDEX idx_api_quota_tracking_account_id ON api_quota_tracking(account_id);
CREATE INDEX idx_stop_loss_retry_queue_user_id ON stop_loss_retry_queue(user_id);
CREATE INDEX idx_stop_loss_retry_queue_ad_id ON stop_loss_retry_queue(ad_id);
CREATE INDEX idx_stop_loss_retry_queue_status ON stop_loss_retry_queue(status);
CREATE INDEX idx_stop_loss_retry_queue_next_retry ON stop_loss_retry_queue(next_retry_at);

-- RLS pour user_roles (seuls les admins peuvent modifier)
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_quota_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE stop_loss_retry_queue ENABLE ROW LEVEL SECURITY;

-- Politiques RLS pour user_roles
CREATE POLICY "Users can view their own role" ON user_roles
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all roles" ON user_roles
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM user_roles 
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- Politiques RLS pour system_settings (seuls les admins)
CREATE POLICY "Admins can manage system settings" ON system_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM user_roles 
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- Politiques RLS pour api_quota_tracking
CREATE POLICY "Users can view their own quota" ON api_quota_tracking
    FOR SELECT USING (auth.uid() = user_id);

-- Politiques RLS pour stop_loss_retry_queue
CREATE POLICY "Users can view their own retry queue" ON stop_loss_retry_queue
    FOR SELECT USING (auth.uid() = user_id);

-- Insérer les paramètres système par défaut
INSERT INTO system_settings (key, value, description) VALUES
('stop_loss_batch', '{
    "enabled": true,
    "batch_interval_ms": 60000,
    "max_parallel_requests": 10,
    "batch_size": 50,
    "max_retries": 3,
    "retry_delay_base_ms": 1000,
    "backoff_multiplier": 2,
    "quota_threshold_percent": 80,
    "throttle_enabled": true
}'::jsonb, 'Configuration du batch stop-loss'),
('rate_limit', '{
    "max_requests_per_hour": 4800,
    "max_batch_requests_per_hour": 200,
    "window_size_ms": 3600000,
    "backoff_enabled": true
}'::jsonb, 'Configuration des rate limits API Meta');

-- Trigger pour updated_at sur les nouvelles tables
CREATE TRIGGER update_user_roles_updated_at 
    BEFORE UPDATE ON user_roles 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_system_settings_updated_at 
    BEFORE UPDATE ON system_settings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_quota_tracking_updated_at 
    BEFORE UPDATE ON api_quota_tracking 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_stop_loss_retry_queue_updated_at 
    BEFORE UPDATE ON stop_loss_retry_queue 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

