-- Création de la table notifications pour le système de stop loss
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('stop_loss', 'info', 'warning', 'error')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  ad_id TEXT,
  ad_name TEXT,
  threshold DECIMAL(10,2),
  actual_value DECIMAL(10,2),
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index pour améliorer les performances
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- RLS (Row Level Security)
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Politique RLS pour que les utilisateurs ne voient que leurs notifications
CREATE POLICY IF NOT EXISTS "Users can view their own notifications" ON notifications
  FOR SELECT USING (auth.uid()::text = user_id);

CREATE POLICY IF NOT EXISTS "Users can insert their own notifications" ON notifications
  FOR INSERT WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY IF NOT EXISTS "Users can update their own notifications" ON notifications
  FOR UPDATE USING (auth.uid()::text = user_id);

CREATE POLICY IF NOT EXISTS "Users can delete their own notifications" ON notifications
  FOR DELETE USING (auth.uid()::text = user_id);

-- Trigger pour updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_notifications_updated_at 
  BEFORE UPDATE ON notifications 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insérer quelques notifications de test
INSERT INTO notifications (user_id, type, title, message, ad_id, ad_name, threshold, actual_value, read) VALUES
('test_user_123', 'stop_loss', 'Test Stop Loss 1', 'La publicité "Test Ad 1" a atteint le seuil de stop loss: Cost per Result ($75.00) > Seuil ($50.00)', 'test_ad_1', 'Test Ad 1', 50.00, 75.00, false),
('test_user_123', 'stop_loss', 'Test Stop Loss 2', 'La publicité "Test Ad 2" a atteint le seuil de stop loss: Ad Spend ($200.00) > Seuil ($100.00) avec 0 résultats', 'test_ad_2', 'Test Ad 2', 100.00, 200.00, false),
('test_user_123', 'info', 'Test Info', 'Notification d\'information de test', 'test_ad_3', 'Test Ad 3', null, null, true);

-- Vérifier que la table a été créée
SELECT 'Table notifications créée avec succès' as status;
SELECT COUNT(*) as total_notifications FROM notifications;