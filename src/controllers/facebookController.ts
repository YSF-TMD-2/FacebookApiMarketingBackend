import { Request, Response } from "../types/express.js";
import { supabase } from "../supabaseClient.js";
import axios from "axios";

// Interface pour le token Facebook
interface FacebookToken {
    id: number;
    userId: string;
    token: string;
    scopes: string | null;
    meta: any | null;
}

// Fonction utilitaire pour créer des logs
async function createLog(userId: string, action: string, details: any) {
    try {
        const { error } = await supabase
            .from('logs')
            .insert({
                userId: userId,
                action,
                details
            } as any);
        
        if (error) {
            console.error('Error creating log:', error);
        }
    } catch (error) {
        console.error('Error creating log:', error);
    }
}

// Fonction helper pour normaliser le statut d'une ad
// Utilise uniquement le statut de l'ad elle-même, indépendamment de la campagne/adset
function normalizeAdStatus(status: string | undefined | null): string {
    // Seul le statut exact "ACTIVE" indique que l'ad est active
    return status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
}

// Fonction utilitaire pour récupérer le token Facebook
export async function getFacebookToken(userId: string): Promise<FacebookToken> {
    const { data: tokenRow, error: tokenError } = await supabase
        .from('access_tokens')
        .select('*')
        .eq('userId', userId)
        .single();
    
    if (tokenError) {
        console.error(`❌ [getFacebookToken] Database error for userId ${userId}:`, {
            code: tokenError.code,
            message: tokenError.message,
            details: tokenError.details,
            hint: tokenError.hint
        });
        
        if (tokenError.code !== 'PGRST116') {
            throw new Error(`Database error: ${tokenError.message}`);
        } else {
            // PGRST116 = no rows found
            console.error(`❌ [getFacebookToken] No token found for userId: ${userId}`);
            throw new Error('No access token found');
        }
    }

    if (!tokenRow) {
        console.error(`❌ [getFacebookToken] Token row is null for userId: ${userId}`);
        throw new Error('No access token found');
    }

    return tokenRow;
}

// Fonction utilitaire pour appeler l'API Facebook avec support AbortController, retry et rate limiting
export async function fetchFbGraph(
    accessToken: string, 
    endpoint: string = 'me', 
    signal?: AbortSignal, 
    userId?: string,
    options: {
        maxRetries?: number;
        retryDelay?: number;
        skipRateLimit?: boolean;
    } = {}
) {
    const { maxRetries = 3, retryDelay = 1000, skipRateLimit = false } = options;
    let lastError: any = null;

    // Importer rateLimitManager dynamiquement pour éviter les dépendances circulaires
    const { rateLimitManager } = await import('../services/rateLimitManager.js');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Vérifier si la requête a été annulée
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }

            // Vérifier le rate limit avant de faire la requête (sauf si skipRateLimit est true)
            if (!skipRateLimit && userId) {
                const canMakeRequest = await rateLimitManager.canMakeRequest(userId);
                if (!canMakeRequest) {
                    const waitTime = await rateLimitManager.getWaitTime(userId);
                    if (waitTime > 0) {
                        console.log(`⏳ [RATE LIMIT] Waiting ${waitTime}ms before request for user ${userId}`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    }
                }
            }

            // Créer un AbortController local si pas de signal fourni
            let localController: AbortController | null = null;
            let finalSignal = signal;

            if (!signal && userId) {
                localController = new AbortController();
                finalSignal = localController.signal;
                
                // Enregistrer le controller dans la map des requêtes actives
                const userRequests = activeRequests.get(userId) || [];
                userRequests.push(localController);
                activeRequests.set(userId, userRequests);
            }

            const response = await axios.get(
                `https://graph.facebook.com/v18.0/${endpoint}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    signal: finalSignal,
                    timeout: 30000
                }
            );

            // Nettoyer le controller local après succès
            if (localController && userId) {
                const userRequests = activeRequests.get(userId) || [];
                const filteredRequests = userRequests.filter(controller => controller !== localController);
                activeRequests.set(userId, filteredRequests);
            }

            // Mettre à jour le quota après succès
            if (!skipRateLimit && userId && response.headers) {
                const quotaHeaders = rateLimitManager.parseQuotaHeaders(response.headers as any);
                await rateLimitManager.updateQuota(userId, undefined, quotaHeaders);
                rateLimitManager.resetBackoff(userId);
            }

            return response.data;

        } catch (error: any) {
            lastError = error;

            // Nettoyer le controller local en cas d'erreur
            if (userId) {
                const userRequests = activeRequests.get(userId) || [];
                const filteredRequests = userRequests.filter(controller => !controller.signal.aborted);
                activeRequests.set(userId, filteredRequests);
            }

            // Vérifier si c'est une annulation
            if (error.name === 'AbortError' || error.message === 'Request aborted') {
                throw new Error('Request aborted');
            }

            const errorData = error.response?.data?.error || {};
            const errorCode = errorData.code;
            const errorMessage = errorData.message || error.message;
            const statusCode = error.response?.status || 0;

            // Gestion spécifique des erreurs de permissions (#10)
            if (errorCode === 10) {
                console.error(`❌ [PERMISSION ERROR] Application does not have permission for this action: ${endpoint}`);
                // Ne pas retry pour les erreurs de permissions - c'est un problème de configuration
                throw new Error(`Permission denied: ${errorMessage}. Please check your Facebook app permissions.`);
            }

            // Gestion des rate limits (code 17 ou 4)
            if (errorCode === 17 || errorCode === 4 || statusCode === 429) {
                console.warn(`⚠️ [RATE LIMIT] Rate limit hit (code ${errorCode}), attempt ${attempt + 1}/${maxRetries}`);
                
                if (userId) {
                    const backoffDelay = rateLimitManager.getBackoffDelay(userId);
                    rateLimitManager.incrementBackoff(userId);
                    
                    if (attempt < maxRetries) {
                        console.log(`⏳ [RATE LIMIT] Waiting ${backoffDelay}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, backoffDelay));
                        continue; // Retry
                    }
                }
                
                // Si on a épuisé les tentatives, throw une erreur spécifique
                throw new Error(`Rate limit exceeded. Please wait before making more requests.`);
            }

            // Gestion des erreurs de token expiré (code 190)
            if (errorCode === 190) {
                console.error(`❌ [TOKEN EXPIRED] Facebook token expired for user ${userId}`);
                throw new Error(`Facebook token expired. Please reconnect your account.`);
            }

            // Gestion des erreurs 400 (Bad Request) - souvent permissions ou paramètres invalides
            if (statusCode === 400 && errorCode !== 10) {
                console.error(`❌ [BAD REQUEST] Invalid request: ${endpoint}`, errorMessage);
                // Ne pas retry pour les erreurs 400 (sauf rate limit)
                throw new Error(`Invalid request: ${errorMessage}`);
            }

            // Gestion des erreurs 500 (Server Error) - retry avec backoff
            if (statusCode >= 500 && attempt < maxRetries) {
                const delay = retryDelay * Math.pow(2, attempt);
                console.warn(`⚠️ [SERVER ERROR] Server error (${statusCode}), retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue; // Retry
            }

            // Si c'est la dernière tentative ou une erreur non-retryable, log et throw
            if (attempt === maxRetries) {
                console.error(`❌ [FINAL ERROR] fetchFbGraph error after ${maxRetries} retries:`, {
                    endpoint,
                    message: errorMessage,
                    status: statusCode,
                    code: errorCode,
                    userId
                });
            } else {
                // Retry avec backoff exponentiel pour les autres erreurs
                const delay = retryDelay * Math.pow(2, attempt);
                console.warn(`⚠️ [RETRY] Error (${errorMessage}), retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
        }
    }

    // Si on arrive ici, toutes les tentatives ont échoué
    throw lastError || new Error('Request failed after all retries');
}

// Fonction pour récupérer TOUS les résultats avec pagination
export async function fetchFbGraphPaginated(accessToken: string, endpoint: string, signal?: AbortSignal, userId?: string, maxPages: number = 50) {
    try {

        let allData: any[] = [];
        let nextUrl: string | null = null;
        let pageCount = 0;
        
        // Construire l'URL initiale avec limit=100 pour récupérer plus de résultats par page
        const baseUrl = `https://graph.facebook.com/v18.0/${endpoint}`;
        const separator = endpoint.includes('?') ? '&' : '?';
        const initialUrl = `${baseUrl}${separator}limit=100`;

        do {
            // Vérifier si la requête a été annulée
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }

            const urlToFetch = nextUrl || initialUrl;

            const response = await axios.get(urlToFetch, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                signal: signal,
                timeout: 30000
            });

            const responseData = response.data;
            
            // Ajouter les données de cette page
            if (responseData.data && Array.isArray(responseData.data)) {
                allData = allData.concat(responseData.data);
            }

            // Vérifier s'il y a une page suivante
            nextUrl = responseData.paging?.next || null;
            pageCount++;

            // Limiter le nombre de pages pour éviter les boucles infinies
            if (pageCount >= maxPages) {
                break;
            }

        } while (nextUrl);

        return {
            data: allData,
            paging: {
                total_pages: pageCount,
                total_items: allData.length
            }
        };

    } catch (error: any) {
        console.error('❌ fetchFbGraphPaginated error:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        throw error;
    }
}

// POST /api/facebook/token - Sauvegarder le token Facebook
export async function saveAccessToken(req: Request, res: Response) {
    try {

        // Récupérer l'userId depuis le token JWT dans les headers
        let userId = req.user?.id;
        
        if (!userId) {
            // Essayer de décoder le token JWT depuis les headers
            const rawAuth = req.headers?.authorization;
            const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
            if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
                try {
                    const token = authHeader.replace('Bearer ', '');
                    // Décoder le JWT (partie payload)
                    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
                    userId = payload.sub; // Le 'sub' contient l'userId
                } catch (error) {
                    console.error('❌ Error decoding JWT:', error);
                }
            }
        }
        
        // Fallback si pas d'userId trouvé
        if (!userId) {
            userId = req.body.userId || 'temp_user';
        }
        const { accessToken } = req.body;


        if (!accessToken) {
            return res.status(400).json({ message: "Access token is required" });
        }

        // Vérifier si un token existe déjà pour cet utilisateur
        const { data: existingToken, error: existingTokenError } = await supabase
            .from('access_tokens')
            .select('*')
            .eq('userId', userId)
            .single();
        if (existingTokenError && existingTokenError.code !== 'PGRST116') {
            console.error('❌ Error checking existing token:', existingTokenError);
        }

        // Valider le token avec Facebook
        let fbData = null;
        try {
            fbData = await fetchFbGraph(accessToken);
        } catch (error: any) {
            await createLog(userId, "UPLOAD_TOKEN_FAILED", {
                error: error?.message || error,
                status: error.response?.status,
                data: error.response?.data
            });
            
            // Gestion spécifique des erreurs Facebook
            if (error.response?.status === 403) {
                const fbError = error.response?.data?.error;
                if (fbError?.code === 4) {
                    return res.status(429).json({ 
                        message: "Facebook API rate limit reached. Please try again in a few minutes.",
                        error: "RATE_LIMIT",
                        retryAfter: 1800 // 30 minutes
                    });
                }
            }
            
            return res.status(400).json({ 
                message: "Failed to validate access token with Facebook",
                error: error.response?.data?.error?.message || error.message
            });
        }

        // Créer ou mettre à jour le token
        if (existingToken) {
            const { error: updateError } = await (supabase as any)
                .from('access_tokens')
                .update({ 
                    token: accessToken,
                    scopes: req.body.scopes || null,
                    meta: fbData || null
                })
                .eq('userId', userId);

            if (updateError) {
                console.error('❌ Update error:', updateError);
                return res.status(500).json({ message: 'Database error' });
            }
        } else {
            // Vérifier d'abord si ce token existe déjà pour un autre utilisateur
            const { data: existingTokenByValue } = await supabase
                .from('access_tokens')
                .select('*')
                .eq('token', accessToken)
                .single();
            
            if (existingTokenByValue) {
                // Mettre à jour l'userId du token existant
                const { error: updateUserIdError } = await (supabase as any)
                    .from('access_tokens')
                    .update({ userId: userId })
                    .eq('token', accessToken);
                
                if (updateUserIdError) {
                    console.error('❌ Update userId error:', updateUserIdError);
                    return res.status(500).json({ message: 'Database error' });
                }
            } else {
                // Créer un nouveau token
                const { error: insertError } = await supabase
                    .from('access_tokens')
                    .insert({
                        userId: userId,
                        token: accessToken,
                        scopes: req.body.scopes || null,
                        meta: fbData || null
                    } as any);

                if (insertError) {
                    console.error('❌ Insert error:', insertError);
                    return res.status(500).json({ message: 'Database error' });
                }
            }
        }

        await createLog(userId, "TOKEN_SAVED", { fbData });
        return res.json({ message: "Access token saved successfully", fbData });

    } catch (error: any) {
        console.error('Error saving access token:', error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
}

// GET /api/facebook/user-data - Récupérer les données utilisateur Facebook
export async function getUserData(req: Request, res: Response) {
    try {
        const userId = req.user!.id;

        try {
            const tokenRow = await getFacebookToken(userId);

            // Récupérer les données de base de Facebook avec gestion d'erreur
            let userData = {};
            try {
                userData = await fetchFbGraph(tokenRow.token, 'me?fields=id,name,email');
            } catch (error) {
                console.error('❌ Error fetching user data:', error);
                // Continuer avec des données vides
            }

            // Récupérer les comptes publicitaires avec gestion d'erreur
            let adAccounts = [];
            try {
                const accountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name,account_status,currency,amount_spent');
                adAccounts = accountsData.data || [];
                
                // Utiliser les comptes publicitaires de base (sans calcul de total spend)
                // Le total spend est maintenant calculé dynamiquement avec le filtre de dates
                
            } catch (error) {
                console.error('❌ Error fetching ad accounts:', error);
                // Continuer avec une liste vide
            }

            // Récupérer les pages avec gestion d'erreur
            let pages = [];
            try {
                const pagesData = await fetchFbGraph(tokenRow.token, 'me/accounts?fields=id,name,category');
                pages = pagesData.data || [];
            } catch (error) {
                console.error('❌ Error fetching pages:', error);
                // Continuer avec une liste vide
            }

            // Récupérer les business managers avec gestion d'erreur
            let business = [];
            try {
                const businessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name,timezone_name');
                business = businessData.data || [];
            } catch (error) {
                console.error('❌ Error fetching business managers:', error);
                // Si erreur de limite de requêtes, essayer avec des champs de base
                if (error.message && error.message.includes('Application request limit reached')) {
                    try {
                        const basicBusinessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name');
                        business = basicBusinessData.data || [];
                    } catch (basicError) {
                        console.error('❌ Error fetching business managers with basic fields:', basicError);
                        business = [];
                    }
                } else {
                    business = [];
                }
            }

            const facebookData = {
                user: userData,
                adAccounts: adAccounts,
                pages: pages,
                business: business,
                tokenInfo: { valid: true }
            };

            return res.json({
                success: true,
                data: facebookData,
                message: "Facebook data retrieved successfully"
            });
        } catch (tokenError: any) {
            console.error('❌ Token error:', tokenError);
            // Si pas de token, retourner une réponse vide au lieu d'une erreur
            if (tokenError.message === 'No access token found') {
                return res.json({
                    success: false,
                    message: "No Facebook account connected",
                    data: null
                });
            }
            throw tokenError;
        }

    } catch (error: any) {
        console.error('❌ Error getting user data:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            error: error.toString()
        });
    }
}

// GET /api/facebook/data - Récupérer les données Facebook
export async function getFbData(req: Request, res: Response) {
    try {
        const userId = req.user!.id;

        try {
            const tokenRow = await getFacebookToken(userId);

            // Récupérer les données de base de Facebook
            const fbData = await fetchFbGraph(tokenRow.token, 'me?fields=id,name,email');

            // Récupérer TOUS les comptes publicitaires avec Business Manager (sans limitation)
            let adAccounts = [];
            try {
                const fbQuery = 'me/adaccounts?fields=id,name,account_id,account_status,currency,timezone_name,business_name,business_id,created_time,amount_spent,balance,spend_cap';
                console.log('🔍 [getFbData] Facebook Graph API Request (with pagination):', fbQuery);
                console.log('📊 [getFbData] Using pagination to fetch ALL ad accounts (no limit)...');
                
                // Utiliser la pagination pour récupérer TOUS les ad accounts
                const allAccountsData = await fetchFbGraphPaginated(tokenRow.token, fbQuery, undefined, userId, 100);
                adAccounts = allAccountsData.data || [];
                
                console.log('✅ [getFbData] Total Ad Accounts retrieved (ALL pages):', adAccounts.length);
                console.log('📊 [getFbData] Ad accounts with Business Manager:', adAccounts.filter((acc: any) => acc.business_name).length);
                console.log('📊 [getFbData] Ad accounts without Business Manager:', adAccounts.filter((acc: any) => !acc.business_name).length);
                
                // Log des Business Managers uniques
                const uniqueBusinessNames = [...new Set(adAccounts.filter((acc: any) => acc.business_name).map((acc: any) => acc.business_name))];
                console.log('📊 [getFbData] Unique Business Managers found:', uniqueBusinessNames.length);
                console.log('📊 [getFbData] Business Managers list:', uniqueBusinessNames);
                
                // Log d'un échantillon des ad accounts avec leurs infos business
                console.log('📊 [getFbData] Sample ad accounts (first 10) with business info:', adAccounts.slice(0, 10).map((acc: any) => ({
                    id: acc.id,
                    name: acc.name,
                    account_id: acc.account_id,
                    business_name: acc.business_name || 'N/A',
                    business_id: acc.business_id || 'N/A',
                    currency: acc.currency,
                    status: acc.account_status
                })));
            } catch (error) {
                console.error('❌ [getFbData] Error fetching ad accounts:', error);
                // Ignore error for ad accounts
            }

            return res.json({
                fbData,
                meta: {
                    user: fbData,
                    adAccounts: adAccounts,
                    pages: [],
                    businessManagers: []
                }
            });
        } catch (tokenError: any) {
            // Si pas de token, retourner une réponse vide au lieu d'une erreur
            if (tokenError.message === 'No access token found') {
                return res.json({
                    message: "No Facebook account connected",
                    fbData: null,
                    meta: null
                });
            }
            throw tokenError;
        }

    } catch (error: any) {
        return res.status(500).json({ message: error.message || "Server error" });
    }
}

// GET /api/facebook/accounts - Récupérer les comptes publicitaires
export async function getAdAccounts(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les comptes publicitaires
        const accounts = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name,account_status,currency');

        return res.json({ accounts: accounts.data || [] });

    } catch (error: any) {
        console.error('Error getting ad accounts:', error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
}

// GET /api/facebook/campaigns/:accountId - Récupérer les campagnes
export async function getAccountCampaigns(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { accountId } = req.params;
        const { status } = req.query;

        // Vérifier le format de l'accountId
        if (!accountId || accountId.length < 5) {
            return res.status(400).json({
                message: "Invalid account ID",
                accountId: accountId
            });
        }

        const tokenRow = await getFacebookToken(userId);

        const endpoint = `${accountId}/campaigns?fields=id,name,status,effective_status,objective,created_time,updated_time`;
        
        let campaignsData = [];

        try {
            const campaigns = await fetchFbGraphPaginated(tokenRow.token, endpoint);
            
            campaignsData = campaigns.data?.map(campaign => ({
                id: campaign.id,
                name: campaign.name,
                account_id: accountId,
                status: campaign.status,
                effective_status: campaign.effective_status,
                objective: campaign.objective,
                created_time: campaign.created_time,
                updated_time: campaign.updated_time
            })) || [];
        } catch (fbError: any) {
            if (fbError.response?.data?.error?.code === 190) {
                return res.status(401).json({
                    success: false,
                    message: "Facebook token expired or invalid. Please reconnect your Facebook account.",
                    error: "TOKEN_EXPIRED",
                    accountId: accountId
                });
            }
            throw fbError;
        }

        // Filtrer par statut si fourni
        if (status) {
            let statusArray = [];
            if (typeof status === 'string') {
                statusArray = status.split(',').map(s => s.trim());
            } else if (Array.isArray(status)) {
                statusArray = status;
            } else {
                statusArray = [status];
            }
            
            campaignsData = campaignsData.filter(campaign => 
                statusArray.includes(campaign.effective_status)
            );
        }
        
        return res.json({ 
            success: true,
            data: campaignsData,
            message: "Campaigns retrieved successfully"
        });

    } catch (error: any) {
        console.error(`❌ Error fetching campaigns for account ${req.params.accountId}:`, error);
        
        // Gestion spécifique des erreurs Facebook
        if (error.response?.data?.error) {
            const fbError = error.response.data.error;
            return res.status(400).json({
                success: false,
                message: `Facebook API Error: ${fbError.message}`,
                details: fbError,
                accountId: req.params.accountId
            });
        }
        
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null,
            accountId: req.params.accountId
        });
    }
}

// GET /api/facebook/account/:accountId/insights - Récupérer les insights Ads
export async function getAccountInsights(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { accountId } = req.params;
        const { 
            dateRange, 
            date_preset, 
            time_range, 
            fields = 'spend,impressions,clicks,ctr,cpc,cpm,actions',
            refresh 
        } = req.query;

        // Vérifier le format de l'accountId
        if (!accountId || accountId.length < 5) {
            return res.status(400).json({
                success: false,
                message: "Invalid account ID",
                accountId: accountId
            });
        }

        const tokenRow = await getFacebookToken(userId);

        // Construire l'endpoint pour les insights
        let endpoint = `${accountId}/insights?fields=${fields}&level=account`;
        
        // Gérer les différents formats de dates
        if (time_range && typeof time_range === 'object') {
            // Gérer time_range[since] et time_range[until]
            const since = (time_range as any).since;
            const until = (time_range as any).until;
            if (since && until) {
                endpoint += `&time_range[since]=${since}&time_range[until]=${until}`;
                console.log(`🔍 Using time_range: ${since} to ${until}`);
            }
        } else if (date_preset) {
            // Utiliser date_preset
            endpoint += `&date_preset=${date_preset}`;
            console.log(`🔍 Using date_preset: ${date_preset}`);
        } else if (dateRange) {
            // Fallback pour dateRange
            if (dateRange === 'last_30d') {
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 30);
                endpoint += `&time_range[since]=${startDate.toISOString().split('T')[0]}&time_range[until]=${endDate.toISOString().split('T')[0]}`;
            } else {
                endpoint += `&date_preset=${dateRange}`;
            }
            console.log(`🔍 Using dateRange: ${dateRange}`);
        } else {
            // Par défaut, utiliser last_30d
            endpoint += `&date_preset=last_30d`;
            console.log(`🔍 Using default date_preset: last_30d`);
        }

        console.log(`🔍 Fetching insights for account ${accountId} with endpoint: ${endpoint}`);
        const insights = await fetchFbGraph(tokenRow.token, endpoint);

        // Retourner les insights avec le format attendu
        const insightsData = insights.data?.[0] || {
            spend: '0',
            impressions: '0',
            clicks: '0',
            ctr: '0',
            cpc: '0',
            cpm: '0',
            actions: []
        };

        console.log(`📊 Found insights for account ${accountId}:`, insightsData);

        return res.json({ 
            success: true,
            data: insightsData,
            message: "Insights retrieved successfully"
        });

    } catch (error: any) {
        console.error(`❌ Error fetching insights for account ${req.params.accountId}:`, error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null,
            accountId: req.params.accountId
        });
    }
}

// GET /api/facebook/campaigns/:campaignId/adsets - Récupérer les ad sets
export async function getCampaignAdsets(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        let { campaignId } = req.params;
        
        // Nettoyer l'ID de campagne (enlever les espaces, préfixes, etc.)
        campaignId = campaignId?.trim();
        
        // Validation de l'ID de campagne
        if (!campaignId || campaignId.length < 5) {
            console.error('❌ Invalid campaign ID format:', campaignId);
            return res.status(400).json({
                success: false,
                message: "Invalid campaign ID",
                campaignId: campaignId
            });
        }

        console.log('🔍 Fetching adsets for campaign:', campaignId, 'userId:', userId);
        
        const tokenRow = await getFacebookToken(userId);
        
        if (!tokenRow || !tokenRow.token) {
            console.error('❌ No Facebook token found for user:', userId);
            return res.status(401).json({
                success: false,
                message: "Facebook token not found. Please reconnect your Facebook account."
            });
        }

        // Récupérer les ad sets de base de la campagne
        const endpoint = `${campaignId}/adsets?fields=id,name,status,created_time,updated_time`;
        
        console.log('🔍 Facebook API endpoint:', endpoint);
        console.log('🔍 Token preview:', tokenRow.token.substring(0, 20) + '...');
        
        let adsetsResponse;
        try {
            adsetsResponse = await fetchFbGraph(tokenRow.token, endpoint, undefined, userId);
        } catch (fbError: any) {
            console.error('❌ Facebook API error:', fbError);
            console.error('❌ Campaign ID used:', campaignId);
            console.error('❌ Error details:', JSON.stringify(fbError.response?.data || fbError, null, 2));
            
            const fbErrorData = fbError.response?.data?.error || {};
            
            // Vérifier si c'est une erreur de permissions ou d'accès
            if (fbErrorData.code === 100 || fbErrorData.type === 'OAuthException' || fbError.response?.status === 403) {
                return res.status(403).json({
                    success: false,
                    message: "You don't have permission to access this campaign. Please check your Facebook account permissions.",
                    error: fbErrorData.message || "Campaign not accessible",
                    errorCode: fbErrorData.code
                });
            }
            
            // Erreur 400 ou autre erreur de validation
            if (fbError.response?.status === 400) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid campaign ID or campaign not accessible",
                    error: fbErrorData.message || fbError.message || "Campaign not accessible",
                    errorCode: fbErrorData.code,
                    campaignId: campaignId
                });
            }
            
            // Autres erreurs
            return res.status(500).json({
                success: false,
                message: "Failed to fetch campaign adsets",
                error: fbErrorData.message || fbError.message || "Unknown error",
                errorCode: fbErrorData.code,
                campaignId: campaignId
            });
        }
        
        // Vérifier si la réponse contient des données
        if (!adsetsResponse || !adsetsResponse.data) {
            console.warn('⚠️ No data in response for campaign:', campaignId);
            return res.json({ 
                adsets: [],
                success: true,
                message: "No adsets found for this campaign"
            });
        }
        
        console.log('✅ Successfully fetched adsets for campaign:', campaignId, 'count:', adsetsResponse.data?.length || 0);

        // Récupérer les métriques pour chaque ad set
        const adsetsWithMetrics = [];
        for (const adset of adsetsResponse.data || []) {
            try {
                const insightsEndpoint = `${adset.id}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions&date_preset=last_30d`;
                const insights = await fetchFbGraph(tokenRow.token, insightsEndpoint, undefined, userId);
                const insightData = insights.data?.[0] || {};
                
                adsetsWithMetrics.push({
                    ...adset,
                    campaign_id: campaignId,
                    spend: parseFloat(insightData.spend || 0),
                    impressions: parseInt(insightData.impressions || 0),
                    clicks: parseInt(insightData.clicks || 0),
                    reach: parseInt(insightData.reach || 0),
                    conversions: parseInt(insightData.conversions || 0),
                    ctr: parseFloat(insightData.ctr || 0),
                    cpc: parseFloat(insightData.cpc || 0),
                    cpm: parseFloat(insightData.cpm || 0),
                    frequency: parseFloat(insightData.frequency || 0),
                    conversion_rate: insightData.clicks > 0 ? (insightData.conversions / insightData.clicks) * 100 : 0
                });
            } catch (insightsError) {
                console.log('⚠️ Error fetching insights for adset', adset.id, ':', insightsError.message);
                // Ajouter l'adset sans métriques en cas d'erreur
                adsetsWithMetrics.push({
                    ...adset,
                    campaign_id: campaignId,
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

        return res.json({ adsets: adsetsWithMetrics });

    } catch (error: any) {
        console.error('❌ Error in getCampaignAdsets:', error);
        
        // Gérer les erreurs spécifiques de l'API Facebook
        if (error.response?.status === 400) {
            return res.status(400).json({
                success: false,
                message: "Invalid campaign ID or campaign not accessible",
                error: error.response?.data?.error?.message || error.message
            });
        }
        
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// GET /api/facebook/adsets/:adsetId/ads - Récupérer les annonces
export async function getAdsetAds(req: Request, res: Response) {
    try {
        console.log('🔍 getAdsetAds called with adsetId:', req.params.adsetId);
        const userId = req.user!.id;
        const { adsetId } = req.params;
        
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les annonces de base de l'ad set
        const endpoint = `${adsetId}/ads?fields=id,name,status,created_time,updated_time,creative{id,name,title,body,call_to_action_type,image_url,link_url}`;
        console.log('🔍 Calling Facebook API with endpoint:', endpoint);
        const ads = await fetchFbGraph(tokenRow.token, endpoint);
        console.log('🔍 Facebook API response for ads:', ads);

        // Récupérer les métriques pour chaque ad
        const adsWithMetrics = [];
        for (const ad of ads.data || []) {
            try {
                const insightsEndpoint = `${ad.id}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions&date_preset=last_30d`;
                const insights = await fetchFbGraph(tokenRow.token, insightsEndpoint, undefined, userId);
                console.log(`📊 Insights for ad ${ad.id}:`, JSON.stringify(insights, null, 2));
                const insightData = insights.data?.[0] || {};
                console.log(`📊 Insight data for ad ${ad.id}:`, insightData);
                
                adsWithMetrics.push({
                    ...ad,
                    adset_id: adsetId,
                    spend: parseFloat(insightData.spend || 0),
                    impressions: parseInt(insightData.impressions || 0),
                    clicks: parseInt(insightData.clicks || 0),
                    reach: parseInt(insightData.reach || 0),
                    conversions: parseInt(insightData.conversions || 0),
                    ctr: parseFloat(insightData.ctr || 0),
                    cpc: parseFloat(insightData.cpc || 0),
                    cpm: parseFloat(insightData.cpm || 0),
                    frequency: parseFloat(insightData.frequency || 0),
                    conversion_rate: insightData.clicks > 0 ? (insightData.conversions / insightData.clicks) * 100 : 0
                });
            } catch (insightsError: any) {
                console.log('⚠️ Error fetching insights for ad', ad.id, ':', insightsError.message);
                // Ajouter l'ad sans métriques en cas d'erreur
                adsWithMetrics.push({
                    ...ad,
                    adset_id: adsetId,
                    spend: 0, impressions: 0, clicks: 0, reach: 0, conversions: 0,
                    ctr: 0, cpc: 0, cpm: 0, frequency: 0, conversion_rate: 0
                });
            }
        }

        return res.json({ ads: adsWithMetrics });

    } catch (error: any) {
        console.error('❌ Error in getAdsetAds:', error);
        return res.status(500).json({ 
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// PUT /api/facebook/ads/:adId/status - Mettre à jour le statut d'une annonce
export async function updateAdStatus(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { status } = req.body;
        
        console.log(`🔄 updateAdStatus called - User: ${userId}, AdId: ${adId}, Status: ${status}`);
        
        if (!adId) {
            return res.status(400).json({ message: "Ad ID is required" });
        }
        
        if (!status) {
            return res.status(400).json({ message: "Status is required" });
        }

        if (!['ACTIVE', 'PAUSED'].includes(status)) {
            return res.status(400).json({ message: "Status must be ACTIVE or PAUSED" });
        }

        const tokenRow = await getFacebookToken(userId);
        console.log(`🔑 Token retrieved for user: ${userId}`);

        // Mettre à jour le statut de l'annonce via l'API Facebook
        // Facebook Graph API nécessite le token dans l'URL, pas dans les headers
        console.log(`📡 Calling Facebook API to update ad ${adId} status to ${status}`);
        const response = await axios.post(
            `https://graph.facebook.com/v18.0/${adId}?access_token=${tokenRow.token}`,
            { status },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log(`✅ Facebook API response:`, response.data);

        // Après la mise à jour, récupérer le statut réel depuis Facebook pour confirmer
        // Cela garantit que nous retournons le statut réel (avec effective_status)
        try {
            const verifyEndpoint = `${adId}?fields=id,status,effective_status`;
            const verifyResponse = await fetchFbGraph(tokenRow.token, verifyEndpoint);
            
            // Normaliser le statut comme dans getAdDetails (uniquement basé sur le statut de l'ad)
            const normalizedStatus = normalizeAdStatus(verifyResponse.status);
            
            console.log(`✅ Verified ad status after update:`, {
                status_from_facebook: verifyResponse.status,
                normalized_status: normalizedStatus
            });
            
            await createLog(userId, "AD_STATUS_UPDATED", { 
                adId, 
                requested_status: status,
                actual_status: verifyResponse.status,
                effective_status: realStatus,
                normalized_status: normalizedStatus,
                response: response.data 
            });
            
            return res.json({ 
                success: true,
                message: "Ad status updated successfully", 
                data: {
                    ...response.data,
                    status: normalizedStatus,
                    effective_status: realStatus
                }
            });
        } catch (verifyError: any) {
            // Si la vérification échoue, retourner quand même la réponse de Facebook
            console.error('⚠️ Could not verify ad status after update:', verifyError);
            await createLog(userId, "AD_STATUS_UPDATED", { adId, status, response: response.data });
            return res.json({ 
                success: true,
                message: "Ad status updated successfully", 
                data: {
                    ...response.data,
                    status: status // Utiliser le statut demandé si la vérification échoue
                }
            });
        }

    } catch (error: any) {
        console.error('❌ Error updating ad status:', error);
        console.error('❌ Error details:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
            stack: error.stack
        });
        
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// GET /api/facebook/account/:accountId/total-spend - Récupérer le montant total dépensé pour toutes les campagnes avec date range
export async function getAccountTotalSpend(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { accountId } = req.params;
        const { 
            dateRange = 'last_30d',
            date_preset,
            time_range,
            since,
            until
        } = req.query;

        console.log(`🔍 Getting total spend for account ${accountId} with params:`, {
            dateRange, date_preset, time_range, since, until
        });

        const tokenRow = await getFacebookToken(userId);

        // Construire l'endpoint pour récupérer le total spend du compte
        let endpoint = `${accountId}/insights?fields=spend`;
        
        // Gérer les paramètres de date
        if (time_range && since && until) {
            endpoint += `&time_range[since]=${since}&time_range[until]=${until}`;
            console.log(`🔍 Using time_range: ${since} to ${until}`);
        } else if (date_preset) {
            endpoint += `&date_preset=${date_preset}`;
            console.log(`🔍 Using date_preset: ${date_preset}`);
        } else if (dateRange) {
            if (dateRange === 'last_30d') {
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 30);
                endpoint += `&time_range[since]=${startDate.toISOString().split('T')[0]}&time_range[until]=${endDate.toISOString().split('T')[0]}`;
            } else {
                endpoint += `&date_preset=${dateRange}`;
            }
            console.log(`🔍 Using dateRange: ${dateRange}`);
        } else {
            // Par défaut, utiliser last_30d
            endpoint += `&date_preset=last_30d`;
            console.log(`🔍 Using default date_preset: last_30d`);
        }

        console.log(`🔍 Fetching total spend for account ${accountId} with endpoint: ${endpoint}`);
        const insights = await fetchFbGraph(tokenRow.token, endpoint);

        // Retourner le total spend
        const totalSpend = insights.data?.[0]?.spend || '0';
        
        // Total spend calculé avec succès

        return res.json({
            success: true,
            data: {
                account_id: accountId,
                total_spend: parseFloat(totalSpend),
                currency: 'USD', // Vous pouvez récupérer la devise du compte si nécessaire
                date_range: {
                    since: since || 'auto',
                    until: until || 'auto'
                }
            },
            message: "Total spend retrieved successfully"
        });

    } catch (error: any) {
        console.error('❌ Error getting total spend:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}


// GET /api/facebook/business/:businessId/accounts - Récupérer les comptes publicitaires d'un Business Manager
export async function getBusinessAdAccounts(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { businessId } = req.params;
        const { dateRange = 'last_30d', since, until } = req.query;
        const tokenRow = await getFacebookToken(userId);

        // Créer un AbortController pour cette requête
        const abortController = new AbortController();
        
        // Stocker le controller dans la requête pour pouvoir l'annuler
        (req as any).abortController = abortController;

        // Récupérer les comptes publicitaires du Business Manager avec métriques
        const accountsData = await fetchFbGraph(tokenRow.token, 
            `${businessId}/owned_ad_accounts?fields=id,name,account_status,currency,amount_spent,balance,timezone_name`,
            abortController.signal,
            userId
        );

        // Pour chaque compte, récupérer les métriques de performance
        const accountsWithMetrics = [];
        for (const account of accountsData.data || []) {
            // Vérifier si la requête a été annulée
            if (abortController.signal.aborted) {
                console.log('🛑 Request aborted during account processing');
                throw new Error('Request aborted');
            }
            
            try {
                // Construire l'endpoint pour les insights selon le type de période
                let insightsEndpoint = `${account.id}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions`;
                
                if (since && until) {
                    // Utiliser les dates personnalisées
                    insightsEndpoint += `&time_range[since]=${since}&time_range[until]=${until}`;
                } else {
                    // Utiliser le preset
                    insightsEndpoint += `&date_preset=${dateRange}`;
                }
                
                // Récupérer les insights du compte pour la période sélectionnée
                const insightsData = await fetchFbGraph(tokenRow.token, 
                    insightsEndpoint,
                    abortController.signal,
                    userId
                );
                
                const insights = insightsData.data?.[0] || {};
                
                // Combiner les données du compte avec les métriques
                accountsWithMetrics.push({
                    ...account,
                    spend: parseFloat(insights.spend || account.amount_spent || 0),
                    impressions: parseInt(insights.impressions || 0),
                    clicks: parseInt(insights.clicks || 0),
                    reach: parseInt(insights.reach || 0),
                    frequency: parseFloat(insights.frequency || 0),
                    cpc: parseFloat(insights.cpc || 0),
                    cpm: parseFloat(insights.cpm || 0),
                    ctr: parseFloat(insights.ctr || 0),
                    conversions: parseInt(insights.conversions || 0)
                });
            } catch (error) {
                console.log(`⚠️ Error getting insights for account ${account.name}:`, error);
                // Ajouter le compte sans métriques
                accountsWithMetrics.push({
                    ...account,
                    spend: parseFloat(account.amount_spent || 0),
                    impressions: 0,
                    clicks: 0,
                    reach: 0,
                    frequency: 0,
                    cpc: 0,
                    cpm: 0,
                    ctr: 0,
                    conversions: 0
                });
            }
        }

        return res.json({ 
            success: true,
            data: accountsWithMetrics,
            businessId: businessId
        });

    } catch (error: any) {
        console.error('Error getting business ad accounts:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}


// GET /api/facebook/ad/:adId - Récupérer les détails d'une ad
export async function getAdDetails(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        const { date_preset, since, until } = req.query;

       
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les détails de base de l'ad
        // IMPORTANT: Toujours récupérer le statut depuis Facebook (pas de cache)
        // Le statut peut changer via le calendrier ou manuellement, donc on doit toujours avoir la version la plus récente
        const endpoint = `${adId}?fields=id,name,status,created_time,updated_time,adset_id,campaign_id,creative{id,name,title,body,call_to_action_type,image_url,video_id,thumbnail_url,link_url,object_story_spec}`;
        const adDetails = await fetchFbGraph(tokenRow.token, endpoint);
        
        // Utiliser uniquement le statut de l'ad elle-même (indépendant de la campagne/adset)
        // Normaliser le statut : ACTIVE ou PAUSED
        const normalizedStatus = normalizeAdStatus(adDetails.status);
        
        // Remplacer le status par le statut normalisé
        adDetails.status = normalizedStatus;
        
        console.log('🔍 [getAdDetails] Status from Facebook:', {
            id: adDetails.id,
            name: adDetails.name,
            status_from_facebook: adDetails.status,
            normalized_status: normalizedStatus,
            updated_time: adDetails.updated_time
        });

        // Si la creative a un video_id, récupérer l'URL de la vidéo
        if (adDetails.creative?.video_id) {
            try {
                const videoEndpoint = `${adDetails.creative.video_id}?fields=source,picture`;
                const videoDetails = await fetchFbGraph(tokenRow.token, videoEndpoint);
                console.log('🔍 Video details:', videoDetails);
                if (videoDetails.source) {
                    adDetails.creative.video_url = videoDetails.source;
                }
                if (videoDetails.picture && !adDetails.creative.thumbnail_url) {
                    adDetails.creative.thumbnail_url = videoDetails.picture;
                }
            } catch (videoError: any) {
                const errorCode = videoError.response?.data?.error?.code;
                const errorMessage = videoError.response?.data?.error?.message || videoError.message;
                
                // Gestion spécifique des erreurs de permissions (#10)
                if (errorCode === 10) {
                    console.warn(`⚠️ [getAdDetails] Permission denied for video endpoint: ${errorMessage}`);
                } else {
                    console.log('⚠️ Could not fetch video URL:', errorMessage);
                }
                // Continuer sans la vidéo - ce n'est pas critique
            }
        }

        // Récupérer les métriques de l'ad
        let adMetrics = {};
        try {
            let insightsEndpoint = `${adId}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions,conversion_values,actions`;
            
            // Construire l'endpoint avec les paramètres de date appropriés
            if (since && until) {
                insightsEndpoint += `&time_range[since]=${since}&time_range[until]=${until}`;
                console.log(`🔍 [getAdDetails] Using time_range: ${since} to ${until}`);
            } else if (date_preset) {
                insightsEndpoint += `&date_preset=${date_preset}`;
                console.log(`🔍 [getAdDetails] Using date_preset: ${date_preset}`);
            } else {
                // Par défaut, utiliser today
                insightsEndpoint += `&date_preset=today`;
                console.log(`🔍 [getAdDetails] Using default date_preset: today`);
            }
            
            console.log(`🔍 [getAdDetails] Full insights endpoint: ${insightsEndpoint}`);
            const insights = await fetchFbGraph(tokenRow.token, insightsEndpoint, undefined, userId);
            const insightData = insights.data?.[0] || {};
            console.log('🔍 [getAdDetails] Insight data:', insightData);
            console.log('🔍 [getAdDetails] Query params received:', { date_preset, since, until });
            
            // Compter les résultats depuis les actions (comme dans la vérification manuelle)
            // Priorité: utiliser conversions/conversion_values de Facebook (plus fiable, évite les doublons)
            // Sinon, compter uniquement les types exacts 'lead', 'purchase', 'conversion' (pas les variations)
            let resultsFromActions = 0;
            if (insightData.conversions || insightData.conversion_values) {
                resultsFromActions = parseFloat(insightData.conversions || insightData.conversion_values || 0);
            } else if (insightData.actions && Array.isArray(insightData.actions)) {
                resultsFromActions = insightData.actions.reduce((total: number, action: any) => {
                    const actionType = action.action_type || '';
                    const actionValue = parseInt(action.value || 0);
                    // Utiliser uniquement les types exacts pour éviter les doublons
                    const isResult = actionType === 'lead' || actionType === 'purchase' || actionType === 'conversion';
                    if (isResult && actionValue > 0) {
                        return total + actionValue;
                    }
                    return total;
                }, 0);
            }
            
            adMetrics = {
                spend: parseFloat(insightData.spend || 0),
                impressions: parseInt(insightData.impressions || 0),
                clicks: parseInt(insightData.clicks || 0),
                reach: parseInt(insightData.reach || 0),
                conversions: parseFloat(insightData.conversions || insightData.conversion_values || 0),
                resultsFromActions: resultsFromActions, // Ajouter les résultats depuis les actions
                actions: insightData.actions || [], // Ajouter les actions pour le frontend
                ctr: parseFloat(insightData.ctr || 0),
                cpc: parseFloat(insightData.cpc || 0),
                cpm: parseFloat(insightData.cpm || 0),
                frequency: parseFloat(insightData.frequency || 0),
                conversion_rate: insightData.clicks > 0 ? (parseFloat(insightData.conversions || insightData.conversion_values || 0) / insightData.clicks) * 100 : 0
            };
            
            console.log(`🔍 [getAdDetails] Results from actions: ${resultsFromActions}, conversions: ${adMetrics.conversions}`);
            console.log('🔍 Ad metrics:', adMetrics);
            
            // Vérifier immédiatement le stop loss si on utilise "today" (métriques du jour)
            const isTodayMetrics = !since && !until && (!date_preset || date_preset === 'today');
            console.log(`🔍 [getAdDetails] Checking stop loss: isTodayMetrics=${isTodayMetrics}, spend=${adMetrics.spend}`);
            
            if (isTodayMetrics && adMetrics.spend > 0) {
                try {
                    console.log(`🔍 [getAdDetails] Triggering immediate stop loss check for ad ${adId}`);
                    
                    // Compter les résultats (conversions, leads, purchases)
                    // Priorité: utiliser conversions/conversion_values de Facebook (plus fiable, évite les doublons)
                    // Sinon, compter uniquement les types exacts 'lead', 'purchase', 'conversion' (pas les variations)
                    let results = 0;
                    if (insightData.conversions || insightData.conversion_values) {
                        results = parseFloat(insightData.conversions || insightData.conversion_values || 0);
                    } else if (insightData.actions && Array.isArray(insightData.actions)) {
                        results = insightData.actions.reduce((total: number, action: any) => {
                            // Utiliser uniquement les types exacts pour éviter les doublons
                            if (action.action_type === 'lead' || action.action_type === 'purchase' || action.action_type === 'conversion') {
                                return total + parseInt(action.value || 0);
                            }
                            return total;
                        }, 0);
                    }
                    
                    console.log(`🔍 [getAdDetails] Current metrics: spend=$${adMetrics.spend}, results=${results}`);
                    
                    // Vérifier les conditions de stop loss
                    const { checkStopLossConditions } = await import('./scheduleController.js');
                    const stopLossCheck = await checkStopLossConditions(userId, adId);
                    
                    console.log(`🔍 [getAdDetails] Stop loss check result: shouldStop=${stopLossCheck.shouldStop}, reason=${stopLossCheck.reason}`);
                    
                    if (stopLossCheck.shouldStop) {
                        console.log(`🛑 Stop loss triggered immediately in getAdDetails for ad ${adId}: ${stopLossCheck.reason}`);
                    }
                } catch (stopLossError: any) {
                    console.error(`❌ Error checking stop loss in getAdDetails:`, stopLossError);
                    console.error(`❌ Error stack:`, stopLossError.stack);
                    // Ne pas bloquer la réponse si la vérification du stop loss échoue
                }
            } else {
                console.log(`⚠️ [getAdDetails] Skipping stop loss check: isTodayMetrics=${isTodayMetrics}, spend=${adMetrics.spend}`);
            }
        } catch (insightsError: any) {
            console.log('⚠️ Error fetching ad insights:', insightsError.message);
            // Utiliser des valeurs par défaut en cas d'erreur
            adMetrics = {
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
            };
        }

        // Combiner les détails de base avec les métriques
        const combinedData = {
            ...adDetails,
            ...adMetrics
        };

        console.log('🔍 Combined ad data:', combinedData);

        return res.json({
            success: true,
            data: combinedData,
            message: "Ad details retrieved successfully"
        });

    } catch (error: any) {
        console.error(`❌ Error fetching ad details for ${req.params.adId}:`, error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// GET /api/facebook/test-accounts - Test spécifique des comptes publicitaires
export async function testAdAccounts(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const tokenRow = await getFacebookToken(userId);

        console.log('🔍 Test spécifique des comptes publicitaires pour user:', userId);

        const results = {
            userId: userId,
            hasToken: !!tokenRow.token,
            tests: []
        };

        // Test 1: Endpoint simple
        try {
            const simpleData = await fetchFbGraph(tokenRow.token, 'me/adaccounts');
            results.tests.push({
                name: 'Ad Accounts Simple',
                success: true,
                count: simpleData.data?.length || 0,
                data: simpleData.data
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Ad Accounts Simple',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        // Test 2: Endpoint avec champs détaillés
        try {
            const detailedData = await fetchFbGraph(tokenRow.token, 
                'me/adaccounts?fields=id,name,account_status,currency,amount_spent,balance,timezone_name,business{id,name}'
            );
            results.tests.push({
                name: 'Ad Accounts Detailed',
                success: true,
                count: detailedData.data?.length || 0,
                data: detailedData.data
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Ad Accounts Detailed',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        // Test 3: Endpoint avec champs minimaux
        try {
            const minimalData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name');
            results.tests.push({
                name: 'Ad Accounts Minimal',
                success: true,
                count: minimalData.data?.length || 0,
                data: minimalData.data
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Ad Accounts Minimal',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        return res.json({
            success: true,
            results: results
        });

    } catch (error: any) {
        console.error('Error in ad accounts test:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// GET /api/facebook/test-simple - Test simple de l'API Facebook
export async function testFacebookSimple(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const tokenRow = await getFacebookToken(userId);

        console.log('🔍 Test simple Facebook pour user:', userId);

        const results = {
            userId: userId,
            hasToken: !!tokenRow.token,
            tests: []
        };

        // Test 1: Informations utilisateur
        try {
            const userData = await fetchFbGraph(tokenRow.token, 'me?fields=id,name,email');
            results.tests.push({
                name: 'User Info',
                success: true,
                data: userData
            });
        } catch (error: any) {
            results.tests.push({
                name: 'User Info',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        // Test 2: Comptes publicitaires simples
        try {
            const accountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name');
            results.tests.push({
                name: 'Ad Accounts Simple',
                success: true,
                count: accountsData.data?.length || 0,
                data: accountsData.data
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Ad Accounts Simple',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        // Test 3: Business Managers simples
        try {
            const businessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name');
            results.tests.push({
                name: 'Business Managers Simple',
                success: true,
                count: businessData.data?.length || 0,
                data: businessData.data
            });
        } catch (error: any) {
            results.tests.push({
                name: 'Business Managers Simple',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        return res.json({
            success: true,
            results: results
        });

    } catch (error: any) {
        console.error('Error in simple Facebook test:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// GET /api/facebook/diagnostic - Diagnostic de la connexion Facebook
export async function facebookDiagnostic(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const tokenRow = await getFacebookToken(userId);

        console.log('🔍 Facebook Diagnostic for user:', userId);

        const diagnostic = {
            userId: userId,
            hasToken: !!tokenRow.token,
            tokenLength: tokenRow.token ? tokenRow.token.length : 0,
            tokenPreview: tokenRow.token ? tokenRow.token.substring(0, 10) + '...' : 'No token',
            tests: []
        };

        // Test 1: Informations de base de l'utilisateur
        try {
            const userData = await fetchFbGraph(tokenRow.token, 'me?fields=id,name,email');
            diagnostic.tests.push({
                name: 'User Info',
                success: true,
                data: userData
            });
        } catch (error: any) {
            diagnostic.tests.push({
                name: 'User Info',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        // Test 2: Business Managers
        try {
            const businessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name');
            diagnostic.tests.push({
                name: 'Business Managers',
                success: true,
                count: businessData.data?.length || 0,
                data: businessData.data
            });
        } catch (error: any) {
            diagnostic.tests.push({
                name: 'Business Managers',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        // Test 3: Comptes publicitaires
        try {
            const accountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name,account_status');
            diagnostic.tests.push({
                name: 'Ad Accounts',
                success: true,
                count: accountsData.data?.length || 0,
                data: accountsData.data
            });
        } catch (error: any) {
            diagnostic.tests.push({
                name: 'Ad Accounts',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        // Test 4: Pages
        try {
            const pagesData = await fetchFbGraph(tokenRow.token, 'me/accounts?fields=id,name');
            diagnostic.tests.push({
                name: 'Pages',
                success: true,
                count: pagesData.data?.length || 0,
                data: pagesData.data
            });
        } catch (error: any) {
            diagnostic.tests.push({
                name: 'Pages',
                success: false,
                error: error.message,
                details: error.response?.data
            });
        }

        return res.json({
            success: true,
            diagnostic: diagnostic
        });

    } catch (error: any) {
        console.error('Error in Facebook diagnostic:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// DELETE /api/facebook/token - Supprimer le token Facebook
export async function disconnectFacebook(req: Request, res: Response) {
    try {
        const userId = req.user!.id;

        // Supprimer le token de la base de données
        const { error } = await supabase
            .from('access_tokens')
            .delete()
            .eq('userId', userId);

        if (error) {
            console.error('Error deleting token:', error);
            return res.status(500).json({ message: 'Database error' });
        }

        await createLog(userId, "FACEBOOK_DISCONNECTED", {});
        return res.json({ message: "Facebook disconnected successfully" });

    } catch (error: any) {
        console.error('Error disconnecting Facebook:', error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
}

// POST /api/facebook/clear-cache - Vider le cache
export async function clearFacebookCache(req: Request, res: Response) {
    try {
        const userId = req.user!.id;

        // Supprimer les logs liés à Facebook
        const { error } = await supabase
            .from('logs')
            .delete()
            .eq('userId', userId)
            .in('action', ['TOKEN_SAVED', 'FB_DATA_RETRIEVED', 'AD_ACCOUNTS_RETRIEVED']);

        if (error) {
            console.error('Error clearing cache:', error);
            return res.status(500).json({ message: 'Database error' });
        }

        await createLog(userId, "CACHE_CLEARED", {});
        return res.json({ message: "Facebook cache cleared successfully" });

    } catch (error: any) {
        console.error('Error clearing cache:', error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
}

// Map pour stocker les AbortControllers actifs par utilisateur
const activeRequests = new Map<string, AbortController[]>();

// Nettoyer les requêtes expirées toutes les 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [userId, controllers] of activeRequests.entries()) {
        const validControllers = controllers.filter(controller => !controller.signal.aborted);
        if (validControllers.length !== controllers.length) {
            activeRequests.set(userId, validControllers);
            console.log('🧹 Cleaned up expired requests for user:', userId);
        }
    }
}, 5 * 60 * 1000); // 5 minutes

// POST /api/facebook/abort-requests - Annuler les requêtes en cours
export async function abortFacebookRequests(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        
        console.log('🛑 Aborting Facebook requests for user:', userId);
        
        // Récupérer les AbortControllers actifs pour cet utilisateur
        const userRequests = activeRequests.get(userId) || [];
        
        // Annuler toutes les requêtes actives
        userRequests.forEach(controller => {
            if (!controller.signal.aborted) {
                console.log('🛑 Aborting active request');
                controller.abort();
            }
        });
        
        // Nettoyer la liste des requêtes
        activeRequests.set(userId, []);
        
        await createLog(userId, "REQUESTS_ABORTED", { 
            abortedCount: userRequests.length 
        });
        
        return res.json({ 
            success: true,
            message: "Facebook requests aborted successfully",
            abortedCount: userRequests.length
        });

    } catch (error: any) {
        console.error('Error aborting requests:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error" 
        });
    }
}

// OAuth callback handler
export async function handleOAuthCallback(req: Request, res: Response) {
    try {
        console.log('🔍 OAuth callback received - Full request:', {
            body: req.body,
            headers: req.headers,
            method: req.method,
            url: req.url
        });
        
        const { code, redirectUri } = req.body;
        
        // Vérifier que les variables d'environnement sont définies
        if (!process.env.FB_CLIENT_ID) {
            console.error('❌ FB_CLIENT_ID not set in environment variables');
            return res.status(500).json({
                success: false,
                message: 'Server configuration error: FB_CLIENT_ID not set'
            });
        }
        
        if (!process.env.FB_APP_SECRET) {
            console.error('❌ FB_APP_SECRET not set in environment variables');
            return res.status(500).json({
                success: false,
                message: 'Server configuration error: FB_APP_SECRET not set'
            });
        }
        
        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Authorization code is required'
            });
        }

        console.log('🔍 OAuth callback received:', { code: code.substring(0, 10) + '...', redirectUri });

        // Debug: Vérifier les variables d'environnement
        console.log('🔍 Environment variables check:', {
            FB_CLIENT_ID: process.env.FB_CLIENT_ID,
            FB_APP_SECRET: process.env.FB_APP_SECRET ? '***' + process.env.FB_APP_SECRET.slice(-4) : 'NOT SET',
            NODE_ENV: process.env.NODE_ENV
        });

        // Exchange code for access token
        const tokenResponse = await axios.get(`https://graph.facebook.com/v18.0/oauth/access_token`, {
            params: {
                client_id: process.env.FB_CLIENT_ID,
                client_secret: process.env.FB_APP_SECRET,
                redirect_uri: redirectUri,
                code: code
            }
        });

        const { access_token, expires_in } = tokenResponse.data;
        
        if (!access_token) {
            return res.status(400).json({
                success: false,
                message: 'Failed to get access token from Facebook'
            });
        }

        console.log('✅ Access token obtained:', access_token.substring(0, 10) + '...');

        // Get user info from Facebook
        const userResponse = await axios.get(`https://graph.facebook.com/v18.0/me`, {
            params: {
                access_token: access_token,
                fields: 'id,name,email'
            }
        });

        const userInfo = userResponse.data;
        console.log('✅ User info obtained:', userInfo);

        // Store token in database (you'll need to implement this based on your auth system)
        // For now, we'll just return success
        return res.json({
            success: true,
            message: 'Facebook account connected successfully',
            data: {
                access_token: access_token,
                user: userInfo,
                expires_in: expires_in
            }
        });

    } catch (error: any) {
        console.error('❌ OAuth callback error:', error.response?.data || error.message);
        
        return res.status(500).json({
            success: false,
            message: 'An error occurred during authentication',
            error: error.response?.data || error.message
        });
    }
}
