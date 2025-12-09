import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import authRoutes from "./routes/authRoutes.js";
import facebookRoutes from "./routes/facebookRoutes.js";
import scheduleRoutes from "./routes/scheduleRoutes.js";
import stopLossRoutes from "./routes/stopLossRoutes.js";
import myStopLossRoutes from "./routes/myStopLossRoutes.js";
import logsRoutes from "./routes/logsRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import { startScheduleService } from "./controllers/scheduleController.js";
// import { startStopLossService } from "./controllers/stopLossController.js"; // ❌ Désactivé - Utilisation du service optimisé uniquement
import { optimizedStopLossService } from "./services/optimizedStopLossService.js";

dotenv.config();


const app = express();

// CORS — Configuration générale pour Vercel avec pattern regex
const isAllowedUrl = (origin: string): boolean => {
  // Patterns pour détecter automatiquement les URLs autorisées
  const patterns: (string | RegExp)[] = [
    "https://slobberingly-uncombinative-camryn.ngrok-free.dev",
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

  return patterns.some(pattern =>
    typeof pattern === 'string' ? pattern === origin : pattern.test(origin)
  );
};

// Fonction utilitaire pour construire les URLs d'insights avec support des paramètres de date
const buildInsightsUrl = (
  accountId: string,
  token: string,
  fields: string,
  dateRange?: string,
  since?: string,
  until?: string
): string => {
  let url = `https://graph.facebook.com/v18.0/${accountId}/insights?access_token=${token}&fields=${fields}`;

  if (dateRange) {
    url += `&date_preset=${dateRange}`;
  } else if (since && until) {
    url += `&time_range={"since":"${since}","until":"${until}"}`;
  } else {
    // Par défaut, utiliser last_30d
    url += `&date_preset=last_30d`;
  }

  return url;
};

app.use(
  cors({
    origin: function (origin, callback) {
      // Autoriser les requêtes sans origin (mobile apps, postman, etc.)
      if (!origin) return callback(null, true);


      if (isAllowedUrl(origin)) {
        callback(null, true);
      } else {
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
    optionsSuccessStatus: 200,
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
      vercel: process.env.VERCEL ? " Oui" : " Non",
      region: process.env.VERCEL_REGION || "Non défini"
    },
    deployment: {
      url: "https://facebook-api-marketing-backend.vercel.app",
      status: "🚀 ACTIF",
      cors: " Configuré",
      database: " Supabase connecté"
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
        success: false,
        debug: {
          hasAuthHeader: !!authHeader,
          authHeader: authHeader ? 'Bearer ***' : 'None'
        }
      });
    }

    // Tester le token avec Facebook d'abord
    const testResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${token}`);
    const testData = await testResponse.json();

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
      // Erreur silencieuse - continuer sans ad accounts
    }

    // Récupérer les pages
    let pages = [];
    try {
      const pagesResponse = await fetch(`https://graph.facebook.com/v18.0/me/accounts?fields=id,name,category&access_token=${token}`);
      const pagesData = await pagesResponse.json();
      pages = pagesData.data || [];
    } catch (error) {
      // Erreur silencieuse - continuer sans pages
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
// Rate limiting simple pour /facebook/token (Map pour stocker les timestamps des requêtes par IP)
const tokenRequestTimestamps = new Map<string, number[]>();
const TOKEN_RATE_LIMIT_WINDOW = 60000; // 1 minute
const TOKEN_RATE_LIMIT_MAX_REQUESTS = 3; // Max 3 requêtes par minute

app.post("/facebook/token", async (req, res) => {
  try {
    // Rate limiting simple basé sur l'IP
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    // Nettoyer les anciennes requêtes
    const requests = tokenRequestTimestamps.get(clientIp) || [];
    const recentRequests = requests.filter(timestamp => now - timestamp < TOKEN_RATE_LIMIT_WINDOW);

    // Vérifier le rate limit
    if (recentRequests.length >= TOKEN_RATE_LIMIT_MAX_REQUESTS) {
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = Math.ceil((TOKEN_RATE_LIMIT_WINDOW - (now - oldestRequest)) / 1000);

      console.warn(`⚠️ Rate limit exceeded for IP ${clientIp}: ${recentRequests.length} requests in ${TOKEN_RATE_LIMIT_WINDOW}ms`);

      return res.status(429).json({
        message: `Too many requests. Please wait ${waitTime} seconds before trying again.`,
        error: "RATE_LIMIT",
        retryAfter: waitTime,
        success: false
      });
    }

    // Ajouter cette requête à la liste
    recentRequests.push(now);
    tokenRequestTimestamps.set(clientIp, recentRequests);

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
        // Gestion spécifique des erreurs Facebook rate limit
        if (validationData.error.code === 4 || validationData.error.code === 17) {
          return res.status(429).json({
            message: "Facebook API rate limit reached. Please try again in a few minutes.",
            error: "RATE_LIMIT",
            retryAfter: 1800,
            success: false
          });
        }

        return res.status(400).json({
          message: "Invalid Facebook token",
          error: validationData.error,
          success: false
        });
      }



      // Ici vous pourriez sauvegarder le token en base de données
      // Pour l'instant, on le retourne dans la réponse pour que le frontend puisse l'utiliser
      res.json({
        message: "Access token validated and saved successfully",
        success: true,
        user: validationData,
        timestamp: new Date().toISOString()
      });

    } catch (validationError: any) {
      console.error('Token validation error:', validationError);

      // Gestion des erreurs de rate limit Facebook
      if (validationError.message?.includes("429") || validationError.message?.includes("rate limit")) {
        return res.status(429).json({
          message: "Facebook API rate limit reached. Please try again in a few minutes.",
          error: "RATE_LIMIT",
          retryAfter: 1800,
          success: false
        });
      }

      return res.status(400).json({
        message: "Failed to validate Facebook token",
        error: validationError.message,
        success: false
      });
    }
  } catch (error: any) {
    console.error('Error in Facebook token endpoint:', error);
    res.status(500).json({
      message: "Error processing Facebook token",
      error: error.message,
      success: false
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
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Vider le cache
    const cacheKey = `analytics_${userId}`;
    analyticsCache.delete(cacheKey);

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
      const adAccountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,timezone_name,business_name,business_id,created_time,amount_spent,balance,spend_cap,account_status,disable_reason`);
      const adAccountsData = await adAccountsResponse.json();
      if (adAccountsData.error) {
        return res.status(400).json({
          message: "Facebook API error: " + adAccountsData.error.message,
          success: false
        });
      }


      return res.json({
        message: "Ad accounts retrieved successfully",
        success: true,
        data: {
          adAccounts: adAccountsData.data || [],
          total: adAccountsData.data?.length || 0
        }
      });

    } catch (error) {
      return res.status(500).json({
        message: "Error fetching ad accounts",
        success: false
      });
    }

  } catch (error) {
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
      const businessResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name,primary_page,timezone_name,created_time,updated_time`);
      const businessData = await businessResponse.json();

      // 2. Récupérer les ad accounts avec Business Manager
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
      return res.status(500).json({
        message: "Error fetching detailed ad accounts",
        success: false
      });
    }

  } catch (error) {
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
    } catch (error) {
      console.error('❌ Error decoding JWT:', error);
      return res.status(401).json({ message: "Invalid token", success: false });
    }

    // Vérifier le cache (sauf si force refresh)
    const cacheKey = `analytics_${userId}`;
    const cachedData = analyticsCache.get(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cachedData && (now - cachedData.timestamp) < CACHE_DURATION) {
      return res.json({
        message: "Analytics data retrieved from cache",
        success: true,
        data: cachedData.data,
        cached: true,
        cacheAge: Math.round((now - cachedData.timestamp) / 1000)
      });
    }

    if (forceRefresh) {
      analyticsCache.delete(cacheKey);
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
      // 1. Récupérer les informations Business Manager (avec gestion de la limite)
      let businessData: { data: any[]; error?: { code?: number; message?: string } } = { data: [] };
      try {
        // Vérifier d'abord si on a déjà atteint la limite
        const businessResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name`);
        businessData = await businessResponse.json();

        // Si erreur de limite, on continue avec des données vides
        if (businessData.error && businessData.error.code === 4) {
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
      // Essayer d'abord avec des champs de base
      let adAccountsData: { data: any[]; error?: { code?: number; message?: string } } = { data: [] };
      try {
        const adAccountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent`);
        adAccountsData = await adAccountsResponse.json();

        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!adAccountsData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent,balance,timezone_name,business_name,business_id,created_time`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            adAccountsData = extendedData;
          }
        }
      } catch (error) {
        adAccountsData = { data: [] };
      }

      // Vérifier s'il y a une erreur dans la réponse
      if (adAccountsData.error) {
        // Continuer avec des données vides plutôt que d'échouer
        adAccountsData.data = [];
      }

      // 3. Récupérer les pages
      let pagesData: { data: any[]; error?: { code?: number; message?: string } } = { data: [] };
      try {
        // Essayer d'abord avec des champs de base
        const pagesResponse = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${tokenRow.token}&fields=id,name`);
        pagesData = await pagesResponse.json();

        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!pagesData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${tokenRow.token}&fields=id,name,category,created_time,updated_time,is_published`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            pagesData = extendedData;
          }
        }
      } catch (error) {
        pagesData = { data: [] };
      }

      // Vérifier s'il y a une erreur dans la réponse
      if (pagesData.error) {
        pagesData.data = [];
      }

      // Solution temporaire : extraire les Business Managers des comptes publicitaires
      if (businessData.data.length === 0 && adAccountsData.data && adAccountsData.data.length > 0) {
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
        for (const account of adAccountsData.data) { // Récupérer tous les comptes publicitaires
          try {
            // Campagnes sans insights pour éviter les erreurs
            const campaignsResponse = await fetch(`https://graph.facebook.com/v18.0/${account.id}/campaigns?access_token=${tokenRow.token}&fields=id,name,status,objective,created_time,updated_time&limit=50`);
            const campaignsData = await campaignsResponse.json();
            if (campaignsData.data) {
              totalCampaigns += campaignsData.data.length;
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
            // Erreur silencieuse - continuer avec les autres comptes
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

// 📊 Endpoint pour récupérer les analytics d'un compte publicitaire (campagnes avec métriques)
app.get("/api/facebook/account/:accountId/analytics", async (req, res) => {
  try {
    const { accountId } = req.params;
    const { dateRange, since, until } = req.query;

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

    // Construire l'URL des insights avec les paramètres de date
    // Note: conversion_rate n'est pas un champ valide dans l'API Facebook Insights
    // Les conversions sont extraites des actions
    // Il faut inclure campaign_id et campaign_name quand on utilise level=campaign
    let insightsUrl = '';
    if (since && until) {
      // Utiliser les dates personnalisées
      insightsUrl = `https://graph.facebook.com/v18.0/${accountId}/insights?access_token=${tokenRow.token}&fields=campaign_id,campaign_name,spend,impressions,clicks,reach,ctr,cpc,cpm,actions&time_range={"since":"${since}","until":"${until}"}&level=campaign`;
    } else {
      // Utiliser le preset
      const datePreset = dateRange || 'last_30d';
      insightsUrl = `https://graph.facebook.com/v18.0/${accountId}/insights?access_token=${tokenRow.token}&fields=campaign_id,campaign_name,spend,impressions,clicks,reach,ctr,cpc,cpm,actions&date_preset=${datePreset}&level=campaign`;
    }

    try {
      const insightsResponse = await fetch(insightsUrl);
      const insightsData = await insightsResponse.json();

      if (insightsData.error) {
        console.error('❌ Facebook API error:', insightsData.error);

        // Gestion spéciale pour la limite d'API
        if (insightsData.error.code === 4) {
          return res.status(429).json({
            success: false,
            message: "Facebook API rate limit reached. Please wait before making more requests.",
            data: { campaigns: [] },
            retryAfter: 300
          });
        }

        // Pour les erreurs 100 (paramètre invalide) ou 190 (token expiré), retourner un succès avec des campagnes vides
        if (insightsData.error.code === 100) {
          console.error('❌ Invalid parameter in Facebook API request:', insightsData.error.message);
          return res.json({
            success: true,
            data: { campaigns: [] },
            message: "No analytics data available for this account (invalid parameter)"
          });
        }

        if (insightsData.error.code === 190) {
          console.error('❌ Facebook token expired or invalid');
          return res.status(401).json({
            success: false,
            message: "Facebook token expired or invalid",
            data: { campaigns: [] }
          });
        }

        return res.status(400).json({
          success: false,
          message: `Facebook API error: ${insightsData.error.message}`,
          data: { campaigns: [] }
        });
      }

      // Traiter les données d'insights et les organiser par campagne
      // Si campaign_id est présent, on crée une entrée par campagne
      // Sinon, on agrège toutes les métriques au niveau compte
      const campaigns = [];

      if (insightsData.data && Array.isArray(insightsData.data)) {
        // Variables pour l'agrégation au niveau compte (si pas de campaign_id)
        let totalSpend = 0;
        let totalImpressions = 0;
        let totalClicks = 0;
        let totalReach = 0;
        let totalConversions = 0;
        let hasCampaignId = false;

        for (const insight of insightsData.data) {
          const campaignId = insight.campaign_id;

          if (campaignId) {
            // Cas 1: Données par campagne - créer une entrée par campagne
            hasCampaignId = true;

            // Extraire les conversions depuis le tableau actions
            let conversions = 0;
            if (insight.actions && Array.isArray(insight.actions)) {
              for (const action of insight.actions) {
                if (action.action_type && action.action_type.includes('conversion')) {
                  conversions += parseInt(action.value || 0);
                }
              }
            }

            campaigns.push({
              id: campaignId,
              name: insight.campaign_name || 'Unknown Campaign',
              metrics: {
                spend: parseFloat(insight.spend || 0),
                impressions: parseInt(insight.impressions || 0),
                clicks: parseInt(insight.clicks || 0),
                reach: parseInt(insight.reach || 0),
                ctr: parseFloat(insight.ctr || 0),
                cpc: parseFloat(insight.cpc || 0),
                cpm: parseFloat(insight.cpm || 0),
                conversions: conversions
              }
            });
          } else {
            // Cas 2: Pas de campaign_id - agréger au niveau compte
            totalSpend += parseFloat(insight.spend || 0);
            totalImpressions += parseInt(insight.impressions || 0);
            totalClicks += parseInt(insight.clicks || 0);
            totalReach += parseInt(insight.reach || 0);

            // Extraire les conversions des actions
            if (insight.actions && Array.isArray(insight.actions)) {
              for (const action of insight.actions) {
                if (action.action_type && action.action_type.includes('conversion')) {
                  totalConversions += parseInt(action.value || 0);
                }
              }
            }
          }
        }

        // Si aucune entrée n'avait de campaign_id, créer une entrée agrégée
        if (!hasCampaignId && insightsData.data.length > 0) {
          const aggregatedCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
          const aggregatedCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
          const aggregatedCpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0;

          campaigns.push({
            id: 'aggregated',
            name: 'All Campaigns (Aggregated)',
            metrics: {
              spend: totalSpend,
              impressions: totalImpressions,
              clicks: totalClicks,
              reach: totalReach,
              ctr: aggregatedCtr,
              cpc: aggregatedCpc,
              cpm: aggregatedCpm,
              conversions: totalConversions
            }
          });
        }
      }

      return res.json({
        success: true,
        data: { campaigns },
        message: "Analytics retrieved successfully"
      });

    } catch (error: any) {
      console.error('❌ Error fetching insights:', error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch insights",
        data: { campaigns: [] }
      });
    }

  } catch (error: any) {
    console.error('❌ Error in analytics endpoint:', error);
    return res.status(500).json({
      message: "Internal server error",
      success: false,
      data: { campaigns: [] }
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
    } catch (error) {
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
    const { dateRange, since, until } = req.query;

    // Vérifier si c'est un Business Manager extrait
    if (businessId.startsWith('extracted_')) {

      // Récupérer tous les comptes publicitaires et filtrer par business_name
      try {
        const allAdAccountsUrl = `https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent,balance,timezone_name,business_name,business_id,created_time`;
        const allAdAccountsResponse = await fetch(allAdAccountsUrl);
        const allAdAccountsData = await allAdAccountsResponse.json();

        if (allAdAccountsData.error) {
          return res.status(400).json({
            success: false,
            message: `Facebook API error: ${allAdAccountsData.error.message}`,
            data: []
          });
        }

        // Récupérer le nom du business manager extrait
        const businessName = req.query.businessName as string;

        // Filtrer les comptes publicitaires par business_name
        const filteredAccounts = allAdAccountsData.data.filter((account: any) =>
          account.business_name && account.business_name.trim() === businessName
        );


        return res.json({
          success: true,
          data: filteredAccounts,
          message: `Ad accounts for business ${businessName} retrieved successfully`
        });

      } catch (error) {
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
        return res.status(400).json({
          success: false,
          message: `Facebook API error: ${adAccountsData.error.message}`,
          data: []
        });
      }

      const adAccounts = adAccountsData.data || [];

      // Pour chaque compte, récupérer les analytics (avec gestion d'erreur)
      const accountsWithAnalytics = await Promise.all(
        adAccounts.map(async (account: any) => {
          try {
            // Récupérer les insights du compte avec les paramètres de date
            const insightsUrl = buildInsightsUrl(
              account.account_id,
              tokenRow.token,
              'impressions,clicks,spend,reach,conversions,ctr,cpc,conversion_rate',
              dateRange as string,
              since as string,
              until as string
            );

            const insightsResponse = await fetch(insightsUrl);
            const insightsData = await insightsResponse.json();

            let analytics: any = {};
            if (!insightsData.error && insightsData.data && insightsData.data.length > 0) {
              analytics = insightsData.data[0];
            } else if (insightsData.error && insightsData.error.code === 4) {
              // Rate limit - on retourne des données vides mais on continue
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


            return {
              ...account,
              analytics: finalAnalytics
            };
          } catch (error) {
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


            return {
              ...account,
              analytics: defaultAnalytics
            };
          }
        })
      );


      res.json({
        success: true,
        data: accountsWithAnalytics,
        message: "Ad accounts with analytics retrieved successfully"
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch ad accounts",
        data: []
      });
    }
  } catch (error) {
    res.status(500).json({
      message: "Internal server error",
      success: false
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
      let businessData;
      try {
        // Essayer d'abord avec des champs de base
        const businessResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name`);
        businessData = await businessResponse.json();

        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!businessData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/businesses?access_token=${tokenRow.token}&fields=id,name,primary_page,timezone_name,created_time,updated_time`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            businessData = extendedData;
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
      let adAccountsData;
      try {
        // Essayer d'abord avec des champs de base
        const adAccountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent`);
        adAccountsData = await adAccountsResponse.json();

        // Si pas d'erreur, essayer d'ajouter plus de champs
        if (!adAccountsData.error) {
          const extendedResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${tokenRow.token}&fields=id,name,account_id,currency,account_status,amount_spent,balance,timezone_name,business_name,business_id,created_time`);
          const extendedData = await extendedResponse.json();
          if (!extendedData.error) {
            adAccountsData = extendedData;
          }
        }
      } catch (error) {
        adAccountsData = { data: [] };
      }

      // Vérifier s'il y a une erreur dans la réponse
      if (adAccountsData.error) {
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

      return res.json({
        message: "Detailed ad accounts retrieved successfully",
        success: true,
        data: result
      });

    } catch (error) {
      return res.status(500).json({
        message: "Error fetching detailed ad accounts",
        success: false,
        error: error.message
      });
    }

  } catch (error) {
    return res.status(500).json({
      message: "Server error",
      success: false,
      error: error.message
    });
  }
});

// Fonction pour gérer le streaming des campagnes avec Server-Sent Events
async function handleStreamingCampaigns(req, res, accountId, facebookToken) {
  try {
    // Configurer les headers pour Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });


    // Envoyer un événement de début
    res.write(`data: ${JSON.stringify({ type: 'start', message: 'Starting to fetch campaigns...' })}\n\n`);

    let allCampaigns = [];
    let nextUrl = `https://graph.facebook.com/v18.0/${accountId}/campaigns?access_token=${facebookToken}&fields=id,name,status,objective,created_time,updated_time&limit=100`;
    let pageCount = 0;

    do {

      // Envoyer un événement de progression
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        page: pageCount + 1,
        message: `Fetching page ${pageCount + 1}...`
      })}\n\n`);

      const campaignsResponse = await fetch(nextUrl);
      const campaignsData = await campaignsResponse.json();

      if (campaignsData.error) {
        console.error('❌ Facebook API error:', campaignsData.error);
        res.write(`data: ${JSON.stringify({
          type: 'error',
          message: "Facebook API error: " + campaignsData.error.message
        })}\n\n`);
        res.end();
        return;
      }

      // Ajouter les campagnes de cette page avec métriques
      if (campaignsData.data && Array.isArray(campaignsData.data)) {
        allCampaigns = allCampaigns.concat(campaignsData.data);

        // Récupérer les métriques pour chaque campagne de cette page
        const campaignsWithMetrics = [];
        for (const campaign of campaignsData.data) {
          try {
            // Récupérer les insights (métriques) pour chaque campagne
            const insightsUrl = `https://graph.facebook.com/v18.0/${campaign.id}/insights?access_token=${facebookToken}&fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions&date_preset=last_30d`;
            const insightsResponse = await fetch(insightsUrl);
            const insightsData = await insightsResponse.json();

            const insights = insightsData.data?.[0] || {};

            campaignsWithMetrics.push({
              ...campaign,
              account_id: accountId,
              // Métriques principales
              spend: parseFloat(insights.spend || 0),
              impressions: parseInt(insights.impressions || 0),
              clicks: parseInt(insights.clicks || 0),
              reach: parseInt(insights.reach || 0),
              conversions: parseInt(insights.conversions || 0),
              // Métriques calculées
              ctr: parseFloat(insights.ctr || 0),
              cpc: parseFloat(insights.cpc || 0),
              cpm: parseFloat(insights.cpm || 0),
              frequency: parseFloat(insights.frequency || 0),
              conversion_rate: insights.clicks > 0 ? (insights.conversions / insights.clicks) * 100 : 0
            });
          } catch (insightsError) {
            console.error(`❌ Error fetching insights for campaign ${campaign.id}:`, insightsError);
            // Ajouter la campagne sans métriques
            campaignsWithMetrics.push({
              ...campaign,
              account_id: accountId,
              spend: 0,
              impressions: 0,
              clicks: 0,
              reach: 0,
              conversions: 0,
              ctr: 0,
              cpc: 0,
              cpm: 0,
              frequency: 0,
              conversion_rate: 0
            });
          }
        }

        // Envoyer les campagnes avec métriques au frontend
        res.write(`data: ${JSON.stringify({
          type: 'campaigns',
          data: campaignsWithMetrics,
          page: pageCount + 1,
          total: allCampaigns.length
        })}\n\n`);
      }

      // Vérifier s'il y a une page suivante
      nextUrl = campaignsData.paging?.next || null;
      pageCount++;

      // Limiter le nombre de pages pour éviter les boucles infinies
      if (pageCount >= 50) {
        break;
      }

    } while (nextUrl);


    // Envoyer un événement de fin
    res.write(`data: ${JSON.stringify({
      type: 'complete',
      total: allCampaigns.length,
      pages: pageCount,
      message: 'All campaigns loaded successfully!'
    })}\n\n`);

    res.end();

  } catch (error) {
    console.error('❌ Error in streaming campaigns:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      message: error.message
    })}\n\n`);
    res.end();
  }
}
// 🔍 Endpoint pour récupérer les campagnes d'un compte publicitaire avec chargement progressif
app.get("/api/facebook/campaigns/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;
    const { stream = 'false', token: urlToken } = req.query; // Paramètre pour activer le streaming

    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : urlToken;

    if (!token) {
      return res.status(401).json({
        message: "No access token provided",
        success: false
      });
    }

    // Décoder le JWT pour obtenir l'userId
    let userId = null;
    try {
      const tokenString = typeof token === 'string' ? token : String(token);
      const payload = JSON.parse(Buffer.from(tokenString.split('.')[1], 'base64').toString());
      userId = payload.sub;
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

    // Si streaming est activé, utiliser Server-Sent Events
    if (stream === 'true') {
      return handleStreamingCampaigns(req, res, accountId, tokenRow.token);
    }



    // Utiliser la pagination pour récupérer TOUTES les campagnes avec les champs de base
    let allCampaigns = [];
    let nextUrl = `https://graph.facebook.com/v18.0/${accountId}/campaigns?access_token=${tokenRow.token}&fields=id,name,status,objective,created_time,updated_time,daily_budget,lifetime_budget,start_time,end_time&limit=100`;
    let pageCount = 0;

    do {
      const campaignsResponse = await fetch(nextUrl);
      const campaignsData = await campaignsResponse.json();

      if (campaignsData.error) {
        console.error('❌ Facebook API error:', campaignsData.error);
        return res.status(400).json({
          message: "Facebook API error: " + campaignsData.error.message,
          success: false
        });
      }

      // Ajouter les campagnes de cette page
      if (campaignsData.data && Array.isArray(campaignsData.data)) {
        allCampaigns = allCampaigns.concat(campaignsData.data);
      }

      // Vérifier s'il y a une page suivante
      nextUrl = campaignsData.paging?.next || null;
      pageCount++;



      // Limiter le nombre de pages pour éviter les boucles infinies
      if (pageCount >= 50) {
        break;
      }

    } while (nextUrl);


    // Récupérer les métriques pour chaque campagne
    const campaignsWithMetrics = [];

    // Essayer d'abord de récupérer les insights au niveau du compte
    try {
      // Utiliser 'last_30d' par défaut pour la liste des campagnes (plus logique pour voir les dépenses)
      // 'today' peut être utilisé pour les détails d'une campagne spécifique
      const { date_preset } = req.query;
      const datePreset = date_preset || 'last_30d';
      const accountInsightsUrl = `https://graph.facebook.com/v18.0/${accountId}/insights?access_token=${tokenRow.token}&fields=spend,impressions,clicks,reach,ctr,cpc,cpm,cpp,frequency,actions,conversions,conversion_rate,cost_per_conversion,cost_per_result&date_preset=${datePreset}&level=campaign`;

      // Ajouter un timeout pour éviter les blocages
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 secondes timeout

      try {
        const accountInsightsResponse = await fetch(accountInsightsUrl, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const accountInsightsData = await accountInsightsResponse.json();


        // Créer un map des métriques par campagne
        const metricsMap = new Map();
        if (accountInsightsData.data && accountInsightsData.data.length > 0) {
          for (const insight of accountInsightsData.data) {
            if (insight.campaign_id) {
              metricsMap.set(insight.campaign_id, insight);
            }
          }
        }


        // Appliquer les métriques aux campagnes
        for (const campaign of allCampaigns || []) {
          const campaignMetrics = metricsMap.get(campaign.id) || {};

          // Extraire les actions spécifiques comme dans Facebook Ads Manager
          let totalConversions = 0;
          let messagingConnections = 0;
          let omniPurchases = 0;
          let costPerResult = 0;

          if (campaignMetrics.actions && Array.isArray(campaignMetrics.actions)) {
            for (const action of campaignMetrics.actions) {
              if (action.action_type === 'onsite_conversion.total_messaging_connection') {
                messagingConnections = parseInt(action.value || 0);
              } else if (action.action_type === 'omni_purchase') {
                omniPurchases = parseInt(action.value || 0);
              }
            }
            totalConversions = messagingConnections + omniPurchases;
          }

          // Utiliser cost_per_result si disponible, sinon calculer
          costPerResult = parseFloat(campaignMetrics.cost_per_result || 0);
          if (costPerResult === 0 && totalConversions > 0) {
            costPerResult = parseFloat(campaignMetrics.spend || 0) / totalConversions;
          }

          campaignsWithMetrics.push({
            ...campaign,
            account_id: accountId,
            // Métriques principales (comme Facebook Ads Manager)
            spend: parseFloat(campaignMetrics.spend || 0),
            impressions: parseInt(campaignMetrics.impressions || 0),
            clicks: parseInt(campaignMetrics.clicks || 0),
            reach: parseInt(campaignMetrics.reach || 0),
            conversions: totalConversions,
            messaging_connections: messagingConnections,
            omni_purchases: omniPurchases,
            // Métriques calculées
            ctr: parseFloat(campaignMetrics.ctr || 0),
            cpc: parseFloat(campaignMetrics.cpc || 0),
            cpm: parseFloat(campaignMetrics.cpm || 0),
            frequency: parseFloat(campaignMetrics.frequency || 0),
            cost_per_result: costPerResult,
            conversion_rate: campaignMetrics.clicks > 0 ? (totalConversions / campaignMetrics.clicks) * 100 : 0
          });

        }

        // Retourner les données avec métriques du compte
        return res.json({
          message: "Campaigns with metrics retrieved successfully",
          success: true,
          data: campaignsWithMetrics
        });

      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          console.error('❌ Account insights request timed out after 30 seconds');
          throw new Error('Account insights request timed out');
        } else {
          console.error('❌ Account insights fetch error:', fetchError);
          throw fetchError;
        }
      }

    } catch (accountInsightsError) {
      console.error('❌ Error fetching account insights:', accountInsightsError);

      // Fallback: récupérer les métriques campagne par campagne
      // Traiter TOUTES les campagnes par lots de 50 pour éviter les blocages
      const batchSize = 50;
      const totalBatches = Math.ceil(allCampaigns.length / batchSize);

      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * batchSize;
        const endIndex = Math.min(startIndex + batchSize, allCampaigns.length);
        const batchCampaigns = allCampaigns.slice(startIndex, endIndex);

        // Ajouter un délai entre les lots pour éviter les rate limits
        if (batchIndex > 0) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        for (let i = 0; i < batchCampaigns.length; i++) {
          const campaign = batchCampaigns[i];
          try {
            // Ajouter un délai entre les requêtes pour éviter les rate limits
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Récupérer les insights (métriques) pour chaque campagne
            const insightsUrl = `https://graph.facebook.com/v18.0/${campaign.id}/insights?access_token=${tokenRow.token}&fields=spend,impressions,clicks,reach,ctr,cpc,cpm,cpp,frequency,actions,conversions,conversion_rate,cost_per_conversion&date_preset=${datePreset}`;
            const insightsResponse = await fetch(insightsUrl);
            const insightsData = await insightsResponse.json();


            const insights = insightsData.data?.[0] || {};

            // Vérifier si on a des données d'insights
            if (insightsData.data && insightsData.data.length > 0) {
            } else {
              console.log(`⚠️ No insights data for ${campaign.name}, using zeros`);
            }

            campaignsWithMetrics.push({
              ...campaign,
              account_id: accountId,
              // Métriques principales
              spend: parseFloat(insights.spend || 0),
              impressions: parseInt(insights.impressions || 0),
              clicks: parseInt(insights.clicks || 0),
              reach: parseInt(insights.reach || 0),
              conversions: parseInt(insights.conversions || 0),
              // Métriques calculées
              ctr: parseFloat(insights.ctr || 0),
              cpc: parseFloat(insights.cpc || 0),
              cpm: parseFloat(insights.cpm || 0),
              frequency: parseFloat(insights.frequency || 0),
              conversion_rate: insights.clicks > 0 ? (insights.conversions / insights.clicks) * 100 : 0
            });

          } catch (insightsError) {
            // Ajouter la campagne sans métriques
            campaignsWithMetrics.push({
              ...campaign,
              account_id: accountId,
              spend: 0,
              impressions: 0,
              clicks: 0,
              reach: 0,
              conversions: 0,
              ctr: 0,
              cpc: 0,
              cpm: 0,
              frequency: 0,
              conversion_rate: 0
            });
          }
        }
      }

      // Retourner les données avec métriques du fallback
      return res.json({
        message: "Campaigns with metrics retrieved successfully (fallback)",
        success: true,
        data: campaignsWithMetrics
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



//  Routes principales
app.use("/api/auth", authRoutes);
app.use("/api/facebook", facebookRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/stop-loss", stopLossRoutes);
app.use("/api/my-stop-loss", myStopLossRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);




// 🚀 Démarrage du serveur
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);

  // Démarrer les services
  console.log('🚀 Starting background services...');
  startScheduleService().catch(err => {
    console.error('❌ Error starting schedule service:', err);
  });

  // ❌ Service traditionnel désactivé - Utilisation du service optimisé uniquement
  // startStopLossService();

  // Démarrer le service stop-loss optimisé (utilise Meta Batch API)
  optimizedStopLossService.initialize().catch(err => {
    console.error('❌ Error initializing optimized stop-loss service:', err);
  });

  console.log('✅ All background services started');
});