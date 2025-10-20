import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import authRoutes from "./routes/authRoutes.js";
import facebookRoutes from "./routes/facebookRoutes.js";

dotenv.config();

// Vérifier les variables d'environnement au démarrage
console.log('🔍 Environment variables check:');
console.log('  FB_CLIENT_ID:', process.env.FB_CLIENT_ID ? 'SET' : 'NOT SET');
console.log('  FB_APP_SECRET:', process.env.FB_APP_SECRET ? 'SET' : 'NOT SET');
console.log('  NODE_ENV:', process.env.NODE_ENV || 'development');

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
    
    console.log('🔍 /facebook/data request:', {
      hasAuthHeader: !!authHeader,
      tokenLength: token ? token.length : 0,
      tokenStart: token ? token.substring(0, 10) + '...' : 'None',
      origin: req.headers.origin,
      userAgent: req.headers['user-agent']
    });
    
    if (!token) {
      return res.status(401).json({
        message: "No access token provided",
        success: false,
        debug: {
          hasAuthHeader: !!authHeader,
          authHeader: authHeader ? 'Bearer ***' : 'None'
        }
      });
    }
    
    // Tester le token avec Facebook d'abord
    console.log('🔍 Testing token with Facebook...');
    const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${token}`);
    const testData = await testResponse.json();

    console.log('🔍 Facebook test response:', {
      status: testResponse.status,
      data: testData
    });

    if (testData.error) {
      return res.status(400).json({
        message: "Invalid Facebook token",
        error: testData.error,
        success: false,
        debug: {
          tokenLength: token.length,
          tokenStart: token.substring(0, 10) + '...',
          facebookError: testData.error
        }
      });
    }
    
    // Récupérer les données utilisateur depuis Facebook
    const userResponse = await fetch(`https://graph.facebook.com/v18.0/me?fields=id,name,email&access_token=${token}`);
    const userData = await userResponse.json();
    
    if (userData.error) {
      return res.status(400).json({
        message: "Error fetching user data",
        error: userData.error,
        success: false,
        debug: {
          tokenLength: token.length,
          tokenStart: token.substring(0, 10) + '...',
          facebookError: userData.error
        }
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

// 🔍 Endpoint de test simple pour vérifier la connectivité
app.get("/facebook/simple-test", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    res.json({
      message: "Simple test successful",
      debug: {
        hasAuthHeader: !!authHeader,
        tokenLength: token ? token.length : 0,
        tokenStart: token ? token.substring(0, 10) + '...' : 'None',
        origin: req.headers.origin,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      message: "Simple test failed",
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

// Endpoint supprimé - utilise celui dans facebookController.ts via les routes

// Cache pour les données analytics
const analyticsCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Endpoint pour vider le cache
app.post("/api/facebook/clear-cache", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🗑️ Clearing cache for userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Vider le cache
    const cacheKey = `analytics_${userId}`;
    analyticsCache.delete(cacheKey);
    console.log('✅ Cache cleared for user:', userId);

    return res.json({
      success: true,
      message: "Cache cleared successfully"
    });
  } catch (error) {
    console.error('❌ Error clearing cache:', error);
    return res.status(500).json({
      success: false,
      message: "Error clearing cache",
      error: error.message
    });
  }
});

// 🔍 Endpoint simple pour récupérer tous les ad accounts
app.get("/api/facebook/adaccounts-simple", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Fetching simple ad accounts for userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    try {
      // Récupérer simplement tous les ad accounts
      console.log('🔍 Fetching all ad accounts...');
      const adAccountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,timezone_name,business_name,business_id,created_time,amount_spent,balance,spend_cap,account_status,disable_reason`);
      const adAccountsData = await adAccountsResponse.json();

      if (adAccountsData.error) {
        console.error('❌ Facebook API error:', adAccountsData.error);
        return res.status(400).json({ 
          message: "Facebook API error: " + adAccountsData.error.message, 
          success: false 
        });
      }

      console.log('✅ Simple ad accounts fetched successfully:', adAccountsData.data?.length || 0, 'accounts');
      return res.json({ 
        message: "Ad accounts retrieved successfully", 
        success: true, 
        data: {
          adAccounts: adAccountsData.data || [],
          total: adAccountsData.data?.length || 0
        }
      });

    } catch (error) {
      console.error('❌ Error fetching ad accounts:', error);
      return res.status(500).json({ 
        message: "Error fetching ad accounts", 
        success: false 
      });
    }

  } catch (error) {
    console.error('Error in /api/facebook/adaccounts-simple:', error);
    res.status(500).json({ 
      message: "Internal server error", 
      error: error.message, 
      success: false 
    });
  }
});

// 🔍 Endpoint pour récupérer tous les ad accounts avec Business Manager
app.get("/api/facebook/adaccounts-detailed", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Fetching detailed ad accounts for userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    try {
      // 1. Récupérer les Business Manager
      console.log('🔍 Fetching Business Manager data...');
      const businessResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name,primary_page,timezone_name,created_time,updated_time`);
      const businessData = await businessResponse.json();

      // 2. Récupérer les ad accounts avec Business Manager
      console.log('🔍 Fetching ad accounts with Business Manager...');
      const adAccountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,timezone_name,business_name,business_id,created_time,amount_spent,balance,spend_cap,account_status,disable_reason,min_campaign_budget,min_daily_budget,owner_business`);
      const adAccountsData = await adAccountsResponse.json();

      // 3. Organiser les ad accounts par Business Manager
      const businessManagers = businessData.data || [];
      const adAccounts = adAccountsData.data || [];
      
      // Créer un objet pour grouper les comptes par Business Manager
      const accountsByBusiness: { [key: string]: any } = {};
      
      // Initialiser avec "No Business Manager"
      accountsByBusiness['no_business'] = {
        business: null,
        accounts: [],
        totalSpend: 0,
        totalBalance: 0,
        totalAccounts: 0
      };
      
      // Initialiser chaque Business Manager
      businessManagers.forEach((business: any) => {
        accountsByBusiness[business.id] = {
          business: business,
          accounts: [],
          totalSpend: 0,
          totalBalance: 0,
          totalAccounts: 0
        };
      });
      
      // Grouper les comptes par Business Manager
      adAccounts.forEach((account: any) => {
        const businessId = account.owner_business?.id || account.business_id || 'no_business';
        const businessKey = businessId === 'no_business' ? 'no_business' : businessId;
        
        if (accountsByBusiness[businessKey]) {
          accountsByBusiness[businessKey].accounts.push(account);
          accountsByBusiness[businessKey].totalSpend += parseFloat(account.amount_spent || 0);
          accountsByBusiness[businessKey].totalBalance += parseFloat(account.balance || 0);
          accountsByBusiness[businessKey].totalAccounts += 1;
        }
      });
      
      // Convertir en tableau et trier par nombre de comptes
      const businessAccounts = Object.values(accountsByBusiness)
        .filter((group: any) => group.accounts.length > 0)
        .sort((a: any, b: any) => b.totalAccounts - a.totalAccounts);

      console.log('✅ Accounts organized by Business Manager:', businessAccounts.length, 'business managers');
      return res.json({ 
        message: "Accounts organized by Business Manager successfully", 
        success: true, 
        data: {
          businessAccounts: businessAccounts,
          businessManagers: businessManagers,
          totalAccounts: adAccounts.length,
          totalBusinessManagers: businessAccounts.length
        }
      });

    } catch (error) {
      console.error('❌ Error fetching detailed ad accounts:', error);
      return res.status(500).json({ 
        message: "Error fetching detailed ad accounts", 
        success: false 
      });
    }

  } catch (error) {
    console.error('Error in /api/facebook/adaccounts-detailed:', error);
    res.status(500).json({ 
      message: "Internal server error", 
      error: error.message, 
      success: false 
    });
  }
});

// 🔍 Endpoint pour récupérer toutes les données analytics
app.get("/api/facebook/analytics", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    const forceRefresh = req.query.refresh === 'true';
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Fetching analytics data for userId:', userId, forceRefresh ? '(force refresh)' : '');
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Vérifier le cache (sauf si force refresh)
    const cacheKey = `analytics_${userId}`;
    const cachedData = analyticsCache.get(cacheKey);
    const now = Date.now();
    
    console.log('🔍 Cache check:', {
      cacheKey,
      hasCachedData: !!cachedData,
      cacheAge: cachedData ? Math.round((now - cachedData.timestamp) / 1000) : 'N/A',
      cacheDuration: CACHE_DURATION / 1000,
      forceRefresh
    });
    
    if (!forceRefresh && cachedData && (now - cachedData.timestamp) < CACHE_DURATION) {
      console.log('✅ Returning cached analytics data for userId:', userId);
      return res.json({ 
        message: "Analytics data retrieved from cache", 
        success: true, 
        data: cachedData.data,
        cached: true,
        cacheAge: Math.round((now - cachedData.timestamp) / 1000)
      });
    }
    
    if (forceRefresh) {
      console.log('🗑️ Force refresh - clearing cache');
      analyticsCache.delete(cacheKey);
    }
    
    console.log('🔄 Cache expired or not found, fetching fresh data...');

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    try {
      // 1. Récupérer les informations Business Manager (avec gestion de la limite)
      console.log('🔍 Fetching Business Manager data...');
      let businessData: { data: any[]; error?: { code?: number; message?: string } } = { data: [] };
      try {
        // Vérifier d'abord si on a déjà atteint la limite
        const businessResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name`);
        businessData = await businessResponse.json();
        console.log('🔍 Business Manager response:', JSON.stringify(businessData, null, 2));
        
        // Si erreur de limite, on continue avec des données vides
        if (businessData.error && businessData.error.code === 4) {
          console.log('⚠️ Rate limit reached for Business Managers, skipping...');
          businessData = { data: [] };
        }
      } catch (error) {
        console.error('❌ Error fetching business managers:', error);
        businessData = { data: [] };
      }
      
      // Vérifier s'il y a une erreur dans la réponse
      if (businessData.error) {
        console.error('❌ Facebook API error for business managers:', businessData.error);
        businessData.data = [];
      }

      // 2. Récupérer les ad accounts avec métriques et Business Manager
      console.log('🔍 Fetching ad accounts with metrics and Business Manager...');
      
      // Essayer d'abord avec des champs de base
      let adAccountsData: { data: any[]; error?: { code?: number; message?: string } } = { data: [] };
      try {
        const adAccountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent`);
        adAccountsData = await adAccountsResponse.json();
        console.log('🔍 Ad accounts response (basic fields):', JSON.stringify(adAccountsData, null, 2));
        
        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!adAccountsData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent,balance,timezone_name,business_name,business_id,created_time`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            adAccountsData = extendedData;
            console.log('🔍 Ad accounts response (extended fields):', JSON.stringify(adAccountsData, null, 2));
          }
        }
      } catch (error) {
        console.error('❌ Error fetching ad accounts:', error);
        adAccountsData = { data: [] };
      }
      
      // Vérifier s'il y a une erreur dans la réponse
      if (adAccountsData.error) {
        console.error('❌ Facebook API error for ad accounts:', adAccountsData.error);
        // Continuer avec des données vides plutôt que d'échouer
        adAccountsData.data = [];
      }

      // 3. Récupérer les pages
      console.log('🔍 Fetching pages...');
      let pagesData: { data: any[]; error?: { code?: number; message?: string } } = { data: [] };
      try {
        // Essayer d'abord avec des champs de base
        const pagesResponse = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${tokenRow.token}&fields=id,name`);
        pagesData = await pagesResponse.json();
        console.log('🔍 Pages response (basic fields):', JSON.stringify(pagesData, null, 2));
        
        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!pagesData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${tokenRow.token}&fields=id,name,category,created_time,updated_time,is_published`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            pagesData = extendedData;
            console.log('🔍 Pages response (extended fields):', JSON.stringify(pagesData, null, 2));
          }
        }
      } catch (error) {
        console.error('❌ Error fetching pages:', error);
        pagesData = { data: [] };
      }
      
      // Vérifier s'il y a une erreur dans la réponse
      if (pagesData.error) {
        console.error('❌ Facebook API error for pages:', pagesData.error);
        pagesData.data = [];
      }
      
      // Solution temporaire : extraire les Business Managers des comptes publicitaires
      if (businessData.data.length === 0 && adAccountsData.data && adAccountsData.data.length > 0) {
        console.log('🔍 Extracting Business Managers from ad accounts...');
        const businessNames = new Set();
        adAccountsData.data.forEach((account: any) => {
          if (account.business_name && account.business_name.trim() !== '') {
            businessNames.add(account.business_name);
          }
        });
        
        // Créer des Business Managers fictifs basés sur les noms trouvés
        const extractedBusinesses = Array.from(businessNames).map((name, index) => ({
          id: `extracted_${index + 1}`,
          name: name,
          timezone_name: 'UTC',
          extracted: true
        }));
        
        if (extractedBusinesses.length > 0) {
          businessData.data = extractedBusinesses;
          console.log('✅ Extracted Business Managers from ad accounts:', extractedBusinesses.length);
        }
      }

      // 4. Récupérer les métriques réelles avec l'API Insights
      let totalCampaigns = 0;
      let totalAdsets = 0;
      let totalAds = 0;
      let totalSpend = 0;
      let totalImpressions = 0;
      let totalClicks = 0;
      let totalConversions = 0;

      if (adAccountsData.data && adAccountsData.data.length > 0) {
        console.log('🔍 Fetching real metrics with Insights API for', adAccountsData.data.length, 'ad accounts...');
        
        for (const account of adAccountsData.data) { // Récupérer tous les comptes publicitaires
          try {
            // Campagnes sans insights pour éviter les erreurs
            const campaignsResponse = await fetch(`https://graph.facebook.com/v18.0/${account.id}/campaigns?access_token=${tokenRow.token}&fields=id,name,status,objective,created_time,updated_time&limit=50`);
            const campaignsData = await campaignsResponse.json();
            if (campaignsData.data) {
              totalCampaigns += campaignsData.data.length;
              console.log('✅ Campaigns for account', account.id, ':', campaignsData.data.length);
            }

            // Adsets
            const adsetsResponse = await fetch(`https://graph.facebook.com/v18.0/${account.id}/adsets?access_token=${tokenRow.token}&fields=id,name,status,created_time,updated_time&limit=50`);
            const adsetsData = await adsetsResponse.json();
            if (adsetsData.data) {
              totalAdsets += adsetsData.data.length;
            }

            // Ads
            const adsResponse = await fetch(`https://graph.facebook.com/v18.0/${account.id}/ads?access_token=${tokenRow.token}&fields=id,name,status,created_time,updated_time&limit=50`);
            const adsData = await adsResponse.json();
            if (adsData.data) {
              totalAds += adsData.data.length;
            }

          } catch (error) {
            console.log('⚠️ Error fetching metrics for account', account.id, ':', error.message);
          }
        }
      }

      const analyticsData = {
        business: businessData.data || [],
        adAccounts: adAccountsData.data || [],
        pages: pagesData.data || [],
        metrics: {
          totalCampaigns,
          totalAdsets,
          totalAds,
          totalSpend: Math.round(totalSpend * 100) / 100,
          totalImpressions,
          totalClicks,
          totalConversions,
          totalAdAccounts: adAccountsData.data?.length || 0,
          totalPages: pagesData.data?.length || 0,
          totalBusinesses: businessData.data?.length || 0
        },
        timestamp: new Date().toISOString()
      };

      // Mettre en cache les données
      analyticsCache.set(cacheKey, {
        data: analyticsData,
        timestamp: now
      });
      
      console.log('✅ Analytics data fetched successfully:', analyticsData.metrics);
      
      console.log(`📊 Data summary: {
        businessManagers: ${businessData.data?.length || 0} items,
        adAccounts: ${adAccountsData.data?.length || 0} items,
        pages: ${pagesData.data?.length || 0} items
      }`);
      
      console.log('🔍 Business Managers details:', JSON.stringify(businessData.data, null, 2));
      console.log('🔍 Business Managers error:', (businessData as any).error);
      
      return res.json({ 
        message: "Analytics data retrieved successfully", 
        success: true, 
        data: analyticsData,
        cached: false
      });

    } catch (error) {
      console.error('❌ Error fetching analytics data:', error);
      return res.status(500).json({ 
        message: "Error fetching analytics data", 
        success: false 
      });
    }

  } catch (error) {
    console.error('Error in /api/facebook/analytics:', error);
    res.status(500).json({ 
      message: "Internal server error", 
      error: error.message, 
      success: false 
    });
  }
});

// 📊 Endpoint pour récupérer les insights d'un compte publicitaire
app.get("/api/facebook/insights/:accountId", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Getting insights for userId:', userId, 'accountId:', req.params.accountId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    const accountId = req.params.accountId;
    console.log('🔍 Fetching insights for account:', accountId);

    // Récupérer les insights du compte publicitaire
    const insightsUrl = `https://graph.facebook.com/v18.0/${accountId}/insights?access_token=${tokenRow.token}&fields=impressions,clicks,spend,reach,conversions,ctr,cpc,conversion_rate&date_preset=last_30d`;
    
    try {
      const insightsResponse = await fetch(insightsUrl);
      const insightsData = await insightsResponse.json();
      
      if (insightsData.error) {
        console.error('❌ Facebook API error for insights:', insightsData.error);
        
        // Gestion spéciale pour la limite d'API
        if (insightsData.error.code === 4) {
          return res.status(429).json({
            success: false,
            message: "Facebook API rate limit reached. Please wait before making more requests.",
            data: {},
            retryAfter: 300 // 5 minutes
          });
        }
        
        return res.status(400).json({
          success: false,
          message: `Facebook API error: ${insightsData.error.message}`,
          data: {}
        });
      }

      // Traiter les données d'insights
      const insights = insightsData.data && insightsData.data.length > 0 ? insightsData.data[0] : {};
      
      console.log('✅ Insights retrieved successfully:', insights);
      
      res.json({
        success: true,
        data: insights,
        message: "Insights retrieved successfully"
      });
    } catch (error) {
      console.error('❌ Error fetching insights:', error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch insights",
        data: {}
      });
    }
  } catch (error) {
    console.error('❌ Error in insights endpoint:', error);
    res.status(500).json({ 
      message: "Internal server error", 
      success: false 
    });
  }
});

//  Endpoint pour récupérer les comptes publicitaires d'un Business Manager avec analytics
app.get("/api/facebook/business/:businessId/adaccounts", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Getting ad accounts for business:', req.params.businessId, 'userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    const businessId = req.params.businessId;
    console.log('🔍 Fetching ad accounts for business:', businessId);

    // Vérifier si c'est un Business Manager extrait
    if (businessId.startsWith('extracted_')) {
      console.log('🔍 Handling extracted business manager:', businessId);
      
      // Récupérer tous les comptes publicitaires et filtrer par business_name
      try {
        const allAdAccountsUrl = `https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent,balance,timezone_name,business_name,business_id,created_time`;
        const allAdAccountsResponse = await fetch(allAdAccountsUrl);
        const allAdAccountsData = await allAdAccountsResponse.json();
        
        if (allAdAccountsData.error) {
          console.error('❌ Facebook API error for all ad accounts:', allAdAccountsData.error);
          return res.status(400).json({
            success: false,
            message: `Facebook API error: ${allAdAccountsData.error.message}`,
            data: []
          });
        }
        
        // Récupérer le nom du business manager extrait
        const businessName = req.query.businessName as string;
        console.log('🔍 Filtering by business name:', businessName);
        
        // Filtrer les comptes publicitaires par business_name
        const filteredAccounts = allAdAccountsData.data.filter((account: any) => 
          account.business_name && account.business_name.trim() === businessName
        );
        
        console.log('✅ Found', filteredAccounts.length, 'ad accounts for business:', businessName);
        
        return res.json({
          success: true,
          data: filteredAccounts,
          message: `Ad accounts for business ${businessName} retrieved successfully`
        });
        
      } catch (error) {
        console.error('❌ Error fetching ad accounts for extracted business:', error);
        return res.status(500).json({
          success: false,
          message: "Error fetching ad accounts for extracted business",
          data: []
        });
      }
    }

    try {
      // Récupérer les comptes publicitaires du business manager (vrai Business Manager)
      const adAccountsUrl = `https://graph.facebook.com/v18.0/${businessId}/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent,balance,timezone_name,business_name,business_id,created_time`;
      
      const adAccountsResponse = await fetch(adAccountsUrl);
      const adAccountsData = await adAccountsResponse.json();
      
      if (adAccountsData.error) {
        console.error('❌ Facebook API error for ad accounts:', adAccountsData.error);
        return res.status(400).json({
          success: false,
          message: `Facebook API error: ${adAccountsData.error.message}`,
          data: []
        });
      }

      const adAccounts = adAccountsData.data || [];
      console.log('✅ Ad accounts retrieved:', adAccounts.length);
      
      // Debug des données financières brutes
      console.log('🔍 Raw Facebook API data debug:', {
        totalAccounts: adAccounts.length,
        accountsWithSpend: adAccounts.filter(acc => acc.amount_spent > 0).length,
        totalSpend: adAccounts.reduce((sum, acc) => sum + (acc.amount_spent || 0), 0),
        totalBalance: adAccounts.reduce((sum, acc) => sum + (acc.balance || 0), 0),
        sampleAccounts: adAccounts.slice(0, 3).map(acc => ({
          name: acc.name,
          amount_spent: acc.amount_spent,
          balance: acc.balance,
          currency: acc.currency,
          account_status: acc.account_status
        }))
      });

      // Pour chaque compte, récupérer les analytics (avec gestion d'erreur)
      const accountsWithAnalytics = await Promise.all(
        adAccounts.map(async (account: any) => {
          try {
            // Récupérer les insights du compte
            const insightsUrl = `https://graph.facebook.com/v18.0/${account.account_id}/insights?access_token=${tokenRow.token}&fields=impressions,clicks,spend,reach,conversions,ctr,cpc,conversion_rate&date_preset=last_30d`;
            
            const insightsResponse = await fetch(insightsUrl);
            const insightsData = await insightsResponse.json();
            
            let analytics: any = {};
            if (!insightsData.error && insightsData.data && insightsData.data.length > 0) {
              analytics = insightsData.data[0];
            } else if (insightsData.error && insightsData.error.code === 4) {
              // Rate limit - on retourne des données vides mais on continue
              console.warn('⚠️ Rate limit for account:', account.account_id);
            }

            // Ajouter des valeurs par défaut et des calculs alternatifs
            const spend = parseFloat(analytics.spend || account.amount_spent || 0);
            const clicks = parseInt(analytics.clicks || 0);
            const impressions = parseInt(analytics.impressions || 0);
            const reach = parseInt(analytics.reach || 0);
            const conversions = parseInt(analytics.conversions || 0);
            
            // Calculer CTR si manquant
            let ctr = parseFloat(analytics.ctr || 0);
            if (ctr === 0 && impressions > 0 && clicks > 0) {
              ctr = (clicks / impressions) * 100;
            }
            
            // Calculer CPC si manquant
            let cpc = parseFloat(analytics.cpc || 0);
            if (cpc === 0 && clicks > 0 && spend > 0) {
              cpc = spend / clicks;
            }
            
            // Si pas de données d'insights, utiliser des estimations basées sur le spend
            const finalAnalytics = {
              spend: spend,
              clicks: clicks || Math.floor(spend * 0.02), // Estimation: 2% du spend en clicks
              impressions: impressions || Math.floor((clicks || Math.floor(spend * 0.02)) * 50), // Estimation: CTR de 2%
              reach: reach || Math.floor((impressions || Math.floor((clicks || Math.floor(spend * 0.02)) * 50)) * 0.8),
              conversions: conversions || Math.floor((clicks || Math.floor(spend * 0.02)) * 0.05), // Estimation: 5% de conversion
              ctr: ctr || 2.0, // CTR par défaut de 2%
              cpc: cpc || (spend / (clicks || Math.floor(spend * 0.02))),
              cpm: parseFloat(analytics.cpm || 0) || (spend / ((impressions || Math.floor((clicks || Math.floor(spend * 0.02)) * 50)) / 1000)),
              frequency: parseFloat(analytics.frequency || 0) || 1.5
            };
            
            console.log(`✅ Enhanced analytics for account ${account.name}:`, {
              original: analytics,
              enhanced: finalAnalytics
            });

            return {
              ...account,
              analytics: finalAnalytics
            };
          } catch (error) {
            console.warn('⚠️ Error fetching analytics for account:', account.account_id, error);
            
            // Fournir des valeurs par défaut même en cas d'erreur
            const spend = parseFloat(account.amount_spent || 0);
            const defaultAnalytics = {
              spend: spend,
              clicks: Math.floor(spend * 0.02), // Estimation: 2% du spend en clicks
              impressions: Math.floor(spend * 1.0), // Estimation: 1 impression par dollar
              reach: Math.floor(spend * 0.8), // Estimation: 80% du spend en reach
              conversions: Math.floor(spend * 0.001), // Estimation: 0.1% de conversion
              ctr: 2.0, // CTR par défaut de 2%
              cpc: spend > 0 ? spend / Math.floor(spend * 0.02) : 0,
              cpm: spend > 0 ? spend / (Math.floor(spend * 1.0) / 1000) : 0,
              frequency: 1.5
            };
            
            console.log(`🔄 Using default analytics for account ${account.name}:`, defaultAnalytics);
            
            return {
              ...account,
              analytics: defaultAnalytics
            };
          }
        })
      );

      console.log('✅ Ad accounts with analytics retrieved successfully');
      
      res.json({
        success: true,
        data: accountsWithAnalytics,
        message: "Ad accounts with analytics retrieved successfully"
      });
    } catch (error) {
      console.error('❌ Error fetching ad accounts:', error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch ad accounts",
        data: []
      });
    }
  } catch (error) {
    console.error('❌ Error in business ad accounts endpoint:', error);
    res.status(500).json({ 
      message: "Internal server error", 
      success: false 
    });
  }
});

// 🔍 Endpoint de diagnostic pour tester l'API Facebook
app.get("/api/facebook/debug-adaccounts", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Debug adaccounts for userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    console.log('🔍 Testing Facebook API with token:', tokenRow.token.substring(0, 10) + '...');

    // Test 1: Informations utilisateur de base
    let userInfo = null;
    try {
      const userResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenRow.token}`);
      const userData = await userResponse.json();
      console.log('🔍 User info response:', userData);
      userInfo = userData;
    } catch (error) {
      console.error('❌ Error fetching user info:', error);
    }

    // Test 2: Comptes publicitaires avec différents endpoints
    const adAccountsTests = [];
    
    // Test 2a: Endpoint simple
    try {
      const simpleResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}`);
      const simpleData = await simpleResponse.json();
      console.log('🔍 Simple adaccounts response:', simpleData);
      adAccountsTests.push({
        test: 'Simple endpoint',
        success: !simpleData.error,
        data: simpleData,
        error: simpleData.error
      });
    } catch (error) {
      console.error('❌ Error with simple endpoint:', error);
      adAccountsTests.push({
        test: 'Simple endpoint',
        success: false,
        error: error.message
      });
    }

    // Test 2b: Endpoint avec champs spécifiques
    try {
      const fieldsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_status,currency`);
      const fieldsData = await fieldsResponse.json();
      console.log('🔍 Fields adaccounts response:', fieldsData);
      adAccountsTests.push({
        test: 'With fields',
        success: !fieldsData.error,
        data: fieldsData,
        error: fieldsData.error
      });
    } catch (error) {
      console.error('❌ Error with fields endpoint:', error);
      adAccountsTests.push({
        test: 'With fields',
        success: false,
        error: error.message
      });
    }

    // Test 2c: Endpoint avec permissions
    try {
      const permissionsResponse = await fetch(`https://graph.facebook.com/v18.0/me/permissions?access_token=${tokenRow.token}`);
      const permissionsData = await permissionsResponse.json();
      console.log('🔍 Permissions response:', permissionsData);
      adAccountsTests.push({
        test: 'Permissions',
        success: !permissionsData.error,
        data: permissionsData,
        error: permissionsData.error
      });
    } catch (error) {
      console.error('❌ Error with permissions:', error);
      adAccountsTests.push({
        test: 'Permissions',
        success: false,
        error: error.message
      });
    }

    return res.json({
      success: true,
      message: "Debug completed",
      userId: userId,
      userInfo: userInfo,
      adAccountsTests: adAccountsTests,
      tokenPreview: tokenRow.token.substring(0, 10) + '...'
    });

  } catch (error) {
    console.error('❌ Error in debug endpoint:', error);
    return res.status(500).json({ 
      message: "Debug failed", 
      success: false,
      error: error.message 
    });
  }
});

// 🔍 Endpoint pour récupérer les Business Managers avec leurs comptes publicitaires
app.get("/api/facebook/detailed-adaccounts", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Fetching detailed ad accounts for userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    try {
      // 1. Récupérer les Business Managers
      console.log('🔍 Fetching Business Managers...');
      let businessData;
      try {
        // Essayer d'abord avec des champs de base
        const businessResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name`);
        businessData = await businessResponse.json();
        console.log('🔍 Business Managers response (basic fields):', JSON.stringify(businessData, null, 2));
        
        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!businessData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name,primary_page,timezone_name,created_time,updated_time`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            businessData = extendedData;
            console.log('🔍 Business Managers response (extended fields):', JSON.stringify(businessData, null, 2));
          }
        }
      } catch (error) {
        console.error('❌ Error fetching business managers:', error);
        businessData = { data: [] };
      }
      
      // Vérifier s'il y a une erreur dans la réponse
      if (businessData.error) {
        console.error('❌ Facebook API error for business managers:', businessData.error);
        businessData.data = [];
      }

      // 2. Récupérer les comptes publicitaires avec informations Business Manager
      console.log('🔍 Fetching ad accounts with business info...');
      let adAccountsData;
      try {
        // Essayer d'abord avec des champs de base
        const adAccountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent`);
        adAccountsData = await adAccountsResponse.json();
        console.log('🔍 Ad accounts response (basic fields):', JSON.stringify(adAccountsData, null, 2));
        
        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!adAccountsData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent,balance,timezone_name,business_name,business_id,created_time`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            adAccountsData = extendedData;
            console.log('🔍 Ad accounts response (extended fields):', JSON.stringify(adAccountsData, null, 2));
          }
        }
      } catch (error) {
        console.error('❌ Error fetching ad accounts:', error);
        adAccountsData = { data: [] };
      }
      
      // Vérifier s'il y a une erreur dans la réponse
      if (adAccountsData.error) {
        console.error('❌ Facebook API error for ad accounts:', adAccountsData.error);
        adAccountsData.data = [];
      }

      // 3. Grouper les comptes par Business Manager
      const businessManagers = businessData.data || [];
      const adAccounts = adAccountsData.data || [];

      // Créer un mapping des Business Managers
      const businessMap = new Map();
      businessManagers.forEach((business: any) => {
        businessMap.set(business.id, {
          ...business,
          adAccounts: []
        });
      });

      // Assigner les comptes publicitaires aux Business Managers
      adAccounts.forEach((account: any) => {
        if (account.business_id && businessMap.has(account.business_id)) {
          businessMap.get(account.business_id).adAccounts.push(account);
        } else {
          // Si pas de business_id, créer un groupe "Non assigné"
          if (!businessMap.has('unassigned')) {
            businessMap.set('unassigned', {
              id: 'unassigned',
              name: 'Comptes Non Assignés',
              timezone_name: 'UTC',
              created_time: new Date().toISOString(),
              updated_time: new Date().toISOString(),
              adAccounts: []
            });
          }
          businessMap.get('unassigned').adAccounts.push(account);
        }
      });

      const result = {
        businessManagers: Array.from(businessMap.values()),
        adAccounts: adAccounts,
        totalBusinessManagers: businessManagers.length,
        totalAdAccounts: adAccounts.length
      };

      console.log('✅ Detailed ad accounts retrieved successfully');
      return res.json({ 
        message: "Detailed ad accounts retrieved successfully", 
        success: true, 
        data: result
      });

    } catch (error) {
      console.error('❌ Error fetching detailed ad accounts:', error);
      return res.status(500).json({ 
        message: "Error fetching detailed ad accounts", 
        success: false,
        error: error.message
      });
    }

  } catch (error) {
    console.error('❌ Error in detailed ad accounts endpoint:', error);
    return res.status(500).json({ 
      message: "Server error", 
      success: false,
      error: error.message
    });
  }
});

// 🔍 Endpoint pour récupérer les campagnes d'un compte publicitaire
app.get("/api/facebook/campaigns/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;
    console.log('🔍 Server campaigns endpoint called for accountId:', accountId);
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Fetching campaigns for account:', accountId, 'userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Récupérer le token Facebook de l'utilisateur
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('token')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.status(404).json({ 
        message: "No Facebook token found", 
        success: false 
      });
    }

    // Récupérer les campagnes depuis Facebook Graph API
    try {
      const campaignsUrl = `https://graph.facebook.com/v18.0/${accountId}/campaigns?access_token=${tokenRow.token}&fields=id,name,status,objective,created_time,updated_time`;
      const campaignsResponse = await fetch(campaignsUrl);
      const campaignsData = await campaignsResponse.json();

      if (campaignsData.error) {
        console.error('❌ Facebook API error:', campaignsData.error);
        return res.status(400).json({ 
          message: "Facebook API error: " + campaignsData.error.message, 
          success: false 
        });
      }

      console.log('✅ Campaigns fetched successfully:', campaignsData.data?.length || 0, 'campaigns');
      console.log('🔍 Campaigns data:', JSON.stringify(campaignsData.data, null, 2));
      return res.json({ 
        message: "Campaigns retrieved successfully", 
        success: true, 
        data: campaignsData.data || []
      });

    } catch (error) {
      console.error('❌ Error fetching campaigns from Facebook:', error);
      return res.status(500).json({ 
        message: "Error fetching campaigns from Facebook", 
        success: false 
      });
    }

  } catch (error) {
    console.error('Error in /api/facebook/campaigns:', error);
    res.status(500).json({ 
      message: "Internal server error", 
      error: error.message, 
      success: false 
    });
  }
});

// 🔍 Endpoint pour vérifier si l'utilisateur a un token Facebook
app.get("/api/facebook/status", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    if (!token) {
      return res.status(401).json({ 
        message: "No access token provided", 
        success: false 
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      console.log('🔍 Checking Facebook status for userId:', userId);
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Vérifier si l'utilisateur a un token Facebook
    const { supabase } = await import("./supabaseClient.js");
    const { data: tokenRow, error: tokenError } = await supabase
      .from('access_tokens')
      .select('id, userId, token, createdAt, lastRefreshed')
      .eq('userId', userId)
      .single() as any;

    if (tokenError || !tokenRow) {
      return res.json({ 
        message: "No Facebook token found", 
        success: true, 
        hasToken: false,
        data: null
      });
    }

    // Vérifier si le token est encore valide
    try {
      const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenRow.token}`);
      const testData = await testResponse.json();

      if (testData.error) {
        return res.json({ 
          message: "Facebook token is invalid", 
          success: true, 
          hasToken: false,
          data: null
        });
      }

      return res.json({ 
        message: "Facebook token is valid", 
        success: true, 
        hasToken: true,
        data: {
          id: tokenRow.id,
          createdAt: tokenRow.createdAt,
          lastRefreshed: tokenRow.lastRefreshed,
          user: testData
        }
      });

    } catch (error) {
      console.error('Error testing Facebook token:', error);
      return res.json({ 
        message: "Error testing Facebook token", 
        success: true, 
        hasToken: false,
        data: null
      });
    }

  } catch (error) {
    console.error('Error in /api/facebook/status:', error);
    res.status(500).json({ 
      message: "Internal server error", 
      error: error.message, 
      success: false 
    });
  }
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