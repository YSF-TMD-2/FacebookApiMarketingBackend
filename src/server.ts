import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import authRoutes from "./routes/authRoutes.js";
import facebookRoutes from "./routes/facebookRoutes.js";

dotenv.config();


const app = express();

// 🔐 CORS — Configuration générale pour Vercel avec pattern regex
const isAllowedUrl = (origin: string): boolean => {
  // Patterns pour détecter automatiquement les URLs autorisées
  const patterns = [
    // Vercel (toutes les URLs *.vercel.app)
    /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/,
    
    // Netlify (toutes les URLs *.netlify.app)
    /^https:\/\/[a-zA-Z0-9-]+\.netlify\.app$/,
    
    // GitHub Pages (toutes les URLs *.github.io)
    /^https:\/\/[a-zA-Z0-9-]+\.github\.io$/,
    
    // Heroku (toutes les URLs *.herokuapp.com)
    /^https:\/\/[a-zA-Z0-9-]+\.herokuapp\.com$/,
    
    // Localhost (développement local)
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    
    // IP locales (développement)
    /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
    /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  ];
  
  return patterns.some(pattern => pattern.test(origin));
};

app.use(
  cors({
    origin: function (origin, callback) {
      // Autoriser les requêtes sans origin (mobile apps, postman, etc.)
      if (!origin) return callback(null, true);
      
      if (isAllowedUrl(origin)) {
        console.log('✅ CORS allowed for URL:', origin);
        callback(null, true);
      } else {
        console.log('❌ CORS blocked origin:', origin);
        callback(new Error('Not allowed by CORS policy'), false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization", 
      "X-Requested-With",
      "Accept",
      "Origin",
      "Access-Control-Allow-Origin",
      "Access-Control-Allow-Headers",
      "Access-Control-Allow-Methods"
    ],
    optionsSuccessStatus: 200, // ✅ Important pour Vercel
    preflightContinue: false
  })
);

// 🔧 Headers CORS manuels pour Vercel - Configuration permissive
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Toujours ajouter les headers CORS pour Vercel
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Max-Age', '86400'); // Cache preflight pour 24h
  
  // Gérer les requêtes OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

// ⚙️ Middlewares globaux
app.use(express.json());

// ✅ Health check simple
app.get("/api/health", (_req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// 🧪 Test endpoint pour vérifier l'hébergement
app.get("/api/test", (_req, res) => {
  res.json({
    message: "🎉 Backend hébergé correctement sur Vercel !",
    status: "✅ SUCCESS",
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      vercel: process.env.VERCEL ? "✅ Oui" : "❌ Non",
      region: process.env.VERCEL_REGION || "Non défini"
    },
    deployment: {
      url: "https://facebook-api-marketing-backend.vercel.app",
      status: "🚀 ACTIF",
      cors: "✅ Configuré",
      database: "✅ Supabase connecté"
    }
  });
});

// 🧪 Test endpoint avancé avec connexion Supabase
app.get("/api/test-full", async (_req, res) => {
  try {
    const { supabase } = await import("./supabaseClient.js");
    
    // Test de connexion Supabase
    const { data, error } = await supabase.from('logs').select('count').limit(1);
    
    res.json({
      message: "🎉 Backend complètement opérationnel !",
      status: "✅ SUCCESS",
      timestamp: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        vercel: process.env.VERCEL ? "✅ Oui" : "❌ Non",
        region: process.env.VERCEL_REGION || "Non défini",
        supabase_url: process.env.SUPABASE_URL ? "✅ Configuré" : "❌ Manquant",
        supabase_key: process.env.SUPABASE_SERVICE_ROLE_KEY ? "✅ Configuré" : "❌ Manquant"
      },
      services: {
        database: error ? `❌ Erreur: ${error.message}` : "✅ Supabase connecté",
        cors: "✅ Configuré",
        auth: "✅ Middleware actif"
      },
      deployment: {
        url: "https://facebook-api-marketing-backend.vercel.app",
        status: "🚀 ACTIF",
        uptime: "✅ Opérationnel"
      }
    });
  } catch (error: any) {
    res.status(500).json({
      message: "❌ Erreur lors du test complet",
      status: "ERROR",
      timestamp: new Date().toISOString(),
      error: error.message,
      environment: {
        node: process.version,
        platform: process.platform,
        vercel: process.env.VERCEL ? "✅ Oui" : "❌ Non"
      }
    });
  }
});

// 🔧 Endpoint CORS spécifique pour Vercel - Configuration permissive
app.options("/api/*", (req, res) => {
  const origin = req.headers.origin;
  
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Max-Age', '86400');
  res.status(200).end();
});

// 🧪 Test endpoint CORS spécifique
app.get("/api/cors-test", (req, res) => {
  const origin = req.headers.origin;
  
  res.json({
    message: "🎉 CORS test successful!",
    origin: origin,
    timestamp: new Date().toISOString(),
    cors: {
      allowed: true, // Toujours autorisé maintenant
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Credentials': 'true'
      }
    },
    request: {
      method: req.method,
      url: req.url,
      headers: {
        origin: req.headers.origin,
        'user-agent': req.headers['user-agent']
      }
    }
  });
});

// 🔍 Test endpoint Facebook data spécifique
app.get("/api/facebook/data", (req, res) => {
  const origin = req.headers.origin;
  
  // Headers CORS explicites
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  
  res.json({
    message: "🎉 Facebook data endpoint accessible!",
    origin: origin,
    timestamp: new Date().toISOString(),
    cors: {
      allowed: true,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Credentials': 'true'
      }
    }
  });
});

// 🔍 Diagnostic endpoint pour vérifier la configuration
app.get("/api/diagnostic", async (_req, res) => {
  try {
    // Test de connexion Supabase
    const { supabase } = await import("./supabaseClient.js");
    const { data, error } = await supabase.from('logs').select('count').limit(1);
    
    res.json({
      message: "🔍 Diagnostic de la configuration Supabase",
      environment: {
        SUPABASE_URL: process.env.SUPABASE_URL ? "✅ Configuré" : "❌ Manquant",
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? "✅ Configuré" : "❌ Manquant",
        NODE_ENV: process.env.NODE_ENV,
        VERCEL: process.env.VERCEL ? "✅ Oui" : "❌ Non"
      },
      supabase: {
        url: process.env.SUPABASE_URL || "Non configuré",
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        connection: error ? `❌ Erreur: ${error.message}` : "✅ Connecté"
      },
      network: {
        status: "✅ OK",
        timestamp: new Date().toISOString()
      }
    });
  } catch (networkError: any) {
    res.status(500).json({
      message: "❌ Erreur de connexion réseau",
      error: networkError.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 🚀 Routes principales
app.use("/api/auth", authRoutes);
app.use("/api/facebook", facebookRoutes);

// 🚀 Démarrage du serveur
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});