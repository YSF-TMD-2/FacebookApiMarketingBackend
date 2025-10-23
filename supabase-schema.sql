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

