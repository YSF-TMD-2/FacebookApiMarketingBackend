# Configuration d'environnement

## Variables requises

Créez un fichier `.env` dans le dossier `backend/` avec les variables suivantes :

```env
# Supabase Configuration
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Server Configuration
PORT=5001
NODE_ENV=development

# Optional: Vercel deployment
VERCEL=0
```

## Où trouver les clés Supabase

1. Allez sur https://supabase.com/dashboard
2. Sélectionnez votre projet
3. Allez dans **Settings > API**
4. Copiez :
   - **Project URL** → `SUPABASE_URL`
   - **anon public** → `SUPABASE_ANON_KEY`
   - **service_role** → `SUPABASE_SERVICE_ROLE_KEY`

## Sécurité

⚠️ **Important** : Ne jamais commiter le fichier `.env` en production !
- Le fichier `.env` est déjà dans `.gitignore`
- Utilisez des variables d'environnement sécurisées en production
