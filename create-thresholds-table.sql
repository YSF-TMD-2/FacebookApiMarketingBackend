-- Créer la table thresholds pour stocker les seuils de stop loss des utilisateurs
CREATE TABLE IF NOT EXISTS thresholds (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    cost_per_result_threshold DECIMAL(10,2) NOT NULL DEFAULT 1.50,
    zero_results_spend_threshold DECIMAL(10,2) NOT NULL DEFAULT 1.50,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Contrainte unique pour s'assurer qu'un utilisateur n'a qu'une seule configuration
    UNIQUE(user_id)
);

-- Créer un index pour améliorer les performances
CREATE INDEX IF NOT EXISTS idx_thresholds_user_id ON thresholds(user_id);

-- Activer RLS (Row Level Security)
ALTER TABLE thresholds ENABLE ROW LEVEL SECURITY;

-- Créer une politique RLS pour que les utilisateurs ne voient que leurs propres thresholds
CREATE POLICY "Users can view their own thresholds" ON thresholds
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own thresholds" ON thresholds
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own thresholds" ON thresholds
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own thresholds" ON thresholds
    FOR DELETE USING (auth.uid() = user_id);

-- Créer une fonction pour mettre à jour automatiquement updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Créer un trigger pour mettre à jour updated_at automatiquement
CREATE TRIGGER update_thresholds_updated_at 
    BEFORE UPDATE ON thresholds 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Commentaires pour la documentation
COMMENT ON TABLE thresholds IS 'Table pour stocker les seuils de stop loss des utilisateurs';
COMMENT ON COLUMN thresholds.user_id IS 'ID de l''utilisateur propriétaire des seuils';
COMMENT ON COLUMN thresholds.cost_per_result_threshold IS 'Seuil de coût par résultat (en dollars)';
COMMENT ON COLUMN thresholds.zero_results_spend_threshold IS 'Seuil de dépense pour les ads sans résultats (en dollars)';
COMMENT ON COLUMN thresholds.created_at IS 'Date de création de la configuration';
COMMENT ON COLUMN thresholds.updated_at IS 'Date de dernière mise à jour de la configuration';
