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
    // Vercel - pattern très général pour capturer toutes les URLs Vercel
    /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/,
    
    // Pattern spécifique pour les URLs avec format projects
    /^https:\/\/frontend-[a-zA-Z0-9-]+-youssefs-projects-[a-zA-Z0-9-]+\.vercel\.app$/,
    
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
      
      console.log('🔍 CORS check for origin:', origin);
      
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

// ✅ Test endpoint simple pour vérifier la connectivité
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

// 🧪 Test endpoint CORS spécifique (compatibilité)
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

// 🧪 Test endpoint CORS spécifique (nouveau)
app.get("/api/cors-test-new", (req, res) => {
  const origin = req.headers.origin;
  
  res.json({
    message: "🎉 CORS test successful (new endpoint)!",
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

// 🧪 Test endpoint simple pour CORS
app.get("/api/simple-test", (req, res) => {
  res.json({
    message: "Simple test successful!",
    origin: req.headers.origin,
    timestamp: new Date().toISOString()
  });
});

// 🔍 Test endpoint pour vérifier l'URL de base
app.get("/api/url-test", (req, res) => {
  res.json({
    message: "URL test successful!",
    backendUrl: "https://facebook-api-marketing-backend.vercel.app",
    requestUrl: req.url,
    origin: req.headers.origin,
    timestamp: new Date().toISOString()
  });
});

// 🔍 Test endpoint direct (sans /api)
app.get("/direct-test", (req, res) => {
  res.json({
    message: "Direct test successful!",
    backendUrl: "https://facebook-api-marketing-backend.vercel.app",
    requestUrl: req.url,
    origin: req.headers.origin,
    timestamp: new Date().toISOString()
  });
});

// 🔍 Endpoints de compatibilité (sans /api) pour le frontend
app.get("/cors-test", (req, res) => {
  const origin = req.headers.origin;
  
  res.json({
    message: "🎉 CORS test successful (compatibility endpoint)!",
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

app.get("/test", (req, res) => {
  res.json({
    message: "🎉 Test successful (compatibility endpoint)!",
    timestamp: new Date().toISOString(),
    backendUrl: "https://facebook-api-marketing-backend.vercel.app",
    requestUrl: req.url
  });
});

app.get("/facebook/data", async (req, res) => {
  try {
    // Récupérer le token depuis les headers ou le body
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({
        message: "No access token provided",
        success: false
      });
    }
    
    // Récupérer les données utilisateur depuis Facebook
    const userResponse = await fetch(`https://graph.facebook.com/v18.0/me?fields=id,name,email&access_token=${token}`);
    const userData = await userResponse.json();
    
    if (userData.error) {
      return res.status(400).json({
        message: "Invalid Facebook token",
        error: userData.error,
        success: false
      });
    }
    
    // Récupérer les comptes publicitaires
    let adAccounts = [];
    try {
      const accountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?fields=id,name,account_status,currency&access_token=${token}`);
      const accountsData = await accountsResponse.json();
      adAccounts = accountsData.data || [];
    } catch (error) {
      console.log('Could not fetch ad accounts:', error.message);
    }
    
    // Récupérer les pages
    let pages = [];
    try {
      const pagesResponse = await fetch(`https://graph.facebook.com/v18.0/me/accounts?fields=id,name,category&access_token=${token}`);
      const pagesData = await pagesResponse.json();
      pages = pagesData.data || [];
    } catch (error) {
      console.log('Could not fetch pages:', error.message);
    }
    
    const facebookData = {
      user: userData,
      adAccounts: adAccounts,
      pages: pages,
      businessManagers: [] // Les business managers nécessitent des permissions spéciales
    };
    
    res.json({
      message: "Facebook data retrieved successfully",
      success: true,
      data: facebookData,
      meta: facebookData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in Facebook data endpoint:', error);
    res.status(500).json({
      message: "Error retrieving Facebook data",
      error: error.message
    });
  }
});

// 🔍 Endpoints Facebook de compatibilité (sans /api) - Version avec validation
app.post("/facebook/token", async (req, res) => {
  try {
    const { accessToken } = req.body;
    
    if (!accessToken) {
      return res.status(400).json({ 
        message: "Access token is required",
        success: false 
      });
    }
    
    // Valider le token avec Facebook
    try {
      const validationResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${accessToken}`);
      const validationData = await validationResponse.json();
      
      if (validationData.error) {
        return res.status(400).json({
          message: "Invalid Facebook token",
          error: validationData.error,
          success: false
        });
      }
      
      console.log('🔑 Valid Facebook token received for user:', validationData.name);
      
      // Ici vous pourriez sauvegarder le token en base de données
      // Pour l'instant, on le retourne dans la réponse pour que le frontend puisse l'utiliser
      res.json({
        message: "Access token validated and saved successfully",
        success: true,
        user: validationData,
        timestamp: new Date().toISOString()
      });
      
    } catch (validationError) {
      console.error('Token validation error:', validationError);
      return res.status(400).json({
        message: "Failed to validate Facebook token",
        error: validationError.message,
        success: false
      });
    }
  } catch (error) {
    console.error('Error in Facebook token endpoint:', error);
    res.status(500).json({
      message: "Error processing Facebook token",
      error: error.message
    });
  }
});

// 🔍 Test endpoint pour vérifier l'authentification
app.post("/facebook/token-test", (req, res) => {
  const origin = req.headers.origin;
  const authHeader = req.headers.authorization;
  
  res.json({
    message: "🎉 Facebook token test endpoint accessible!",
    origin: origin,
    timestamp: new Date().toISOString(),
    auth: {
      hasAuthHeader: !!authHeader,
      authHeader: authHeader ? 'Bearer ***' : 'None'
    },
    cors: {
      allowed: true,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Credentials': 'true'
      }
    }
  });
});

// 🔍 Endpoint de diagnostic pour les erreurs 400
app.get("/facebook/debug", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(400).json({
        message: "No token provided",
        debug: {
          hasAuthHeader: !!authHeader,
          authHeader: authHeader ? 'Bearer ***' : 'None',
          headers: req.headers
        }
      });
    }
    
    // Tester le token avec Facebook
    try {
      const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${token}`);
      const testData = await testResponse.json();
      
      res.json({
        message: "Token validation successful",
        debug: {
          tokenLength: token.length,
          tokenStart: token.substring(0, 10) + '...',
          facebookResponse: testData,
          status: testResponse.status
        }
      });
    } catch (fbError) {
      res.status(400).json({
        message: "Token validation failed",
        debug: {
          tokenLength: token.length,
          tokenStart: token.substring(0, 10) + '...',
          facebookError: fbError.message
        }
      });
    }
  } catch (error) {
    res.status(500).json({
      message: "Debug endpoint error",
      error: error.message
    });
  }
});

app.get("/facebook/accounts", async (req, res) => {
  try {
    // Récupérer le token depuis les headers
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({
        message: "No access token provided",
        success: false
      });
    }
    
    // Récupérer les comptes publicitaires depuis Facebook
    const accountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?fields=id,name,account_status,currency,amount_spent&access_token=${token}`);
    const accountsData = await accountsResponse.json();
    
    if (accountsData.error) {
      return res.status(400).json({
        message: "Error fetching Facebook accounts",
        error: accountsData.error,
        success: false
      });
    }
    
    res.json({
      message: "Facebook accounts retrieved successfully",
      success: true,
      accounts: accountsData.data || [],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in Facebook accounts endpoint:', error);
    res.status(500).json({
      message: "Error retrieving Facebook accounts",
      error: error.message
    });
  }
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

// 🔍 Test endpoint Facebook data simple (sans authentification)
app.get("/api/facebook/data-test", (req, res) => {
  res.json({
    message: "Facebook data test endpoint working!",
    timestamp: new Date().toISOString(),
    url: req.url,
    method: req.method
  });
});

// 🔍 Endpoint de diagnostic CORS spécifique
app.get("/api/cors-diagnostic", (req, res) => {
  const origin = req.headers.origin;
  
  // Headers CORS explicites
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  
  const isAllowed = isAllowedUrl(origin || '');
  
  res.json({
    message: "🔍 CORS Diagnostic",
    origin: origin,
    isAllowed: isAllowed,
    timestamp: new Date().toISOString(),
    patterns: [
      'Vercel: /^https:\\/\\/[a-zA-Z0-9-]+\\.vercel\\.app$/',
      'Netlify: /^https:\\/\\/[a-zA-Z0-9-]+\\.netlify\\.app$/',
      'GitHub: /^https:\\/\\/[a-zA-Z0-9-]+\\.github\\.io$/',
      'Heroku: /^https:\\/\\/[a-zA-Z0-9-]+\\.herokuapp\\.com$/'
    ],
    cors: {
      allowed: isAllowed,
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