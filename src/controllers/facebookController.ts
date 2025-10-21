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

// Fonction utilitaire pour récupérer le token Facebook
export async function getFacebookToken(userId: string): Promise<FacebookToken> {
    const { data: tokenRow, error: tokenError } = await supabase
        .from('access_tokens')
        .select('*')
        .eq('userId', userId)
        .single();
    
    if (tokenError && tokenError.code !== 'PGRST116') {
        console.error('Database error in getFacebookToken:', tokenError);
        throw new Error('Database error');
    }

    if (!tokenRow) {
        throw new Error('No access token found');
    }

    return tokenRow;
}

// Fonction utilitaire pour appeler l'API Facebook avec support AbortController
export async function fetchFbGraph(accessToken: string, endpoint: string = 'me', signal?: AbortSignal, userId?: string) {
    try {
        console.log('🔍 fetchFbGraph called with:', {
            endpoint,
            accessToken: accessToken ? accessToken.substring(0, 10) + '...' : 'undefined',
            hasSignal: !!signal,
            userId: userId || 'unknown'
        });

        // Vérifier si la requête a été annulée
        if (signal?.aborted) {
            console.log('🛑 Request aborted before execution');
            throw new Error('Request aborted');
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
            
            console.log('📝 Registered request for user:', userId, 'Total active:', userRequests.length);
        }

        const response = await axios.get(
            `https://graph.facebook.com/v18.0/${endpoint}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                signal: finalSignal, // Passer le signal d'annulation à axios
                timeout: 30000 // Timeout de 30 secondes
            }
        );

        // Nettoyer le controller local après succès
        if (localController && userId) {
            const userRequests = activeRequests.get(userId) || [];
            const filteredRequests = userRequests.filter(controller => controller !== localController);
            activeRequests.set(userId, filteredRequests);
            console.log('✅ Request completed and cleaned up for user:', userId);
        }

        console.log('✅ fetchFbGraph success:', response.data);
        return response.data;
    } catch (error: any) {
        // Nettoyer le controller local en cas d'erreur
        if (userId) {
            const userRequests = activeRequests.get(userId) || [];
            const filteredRequests = userRequests.filter(controller => !controller.signal.aborted);
            activeRequests.set(userId, filteredRequests);
        }

        // Vérifier si c'est une annulation
        if (error.name === 'AbortError' || error.message === 'Request aborted') {
            console.log('🛑 Request aborted during execution');
            throw new Error('Request aborted');
        }
        
        console.error('❌ fetchFbGraph error:', {
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
        console.log('🔍 saveAccessToken called with:', {
            body: req.body,
            user: req.user,
            headers: req.headers
        });

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
                    console.log('🔍 Extracted userId from JWT:', userId);
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

        console.log('🔍 Processing with userId:', userId, 'accessToken:', accessToken ? accessToken.substring(0, 10) + '...' : 'undefined');

        if (!accessToken) {
            return res.status(400).json({ message: "Access token is required" });
        }

        // Vérifier si un token existe déjà pour cet utilisateur
        console.log('🔍 Checking for existing token for userId:', userId);
        const { data: existingToken, error: existingTokenError } = await supabase
            .from('access_tokens')
            .select('*')
            .eq('userId', userId)
            .single();
        
        console.log('🔍 Existing token result:', existingToken);
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
        console.log('🔍 Processing token save/update for userId:', userId);
        if (existingToken) {
            console.log('🔍 Updating existing token for userId:', userId);
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
            console.log('✅ Token updated successfully');
        } else {
            console.log('🔍 Creating new token for userId:', userId);
            // Vérifier d'abord si ce token existe déjà pour un autre utilisateur
            const { data: existingTokenByValue } = await supabase
                .from('access_tokens')
                .select('*')
                .eq('token', accessToken)
                .single();
            
            if (existingTokenByValue) {
                console.log('🔍 Token already exists for another user, updating userId');
                // Mettre à jour l'userId du token existant
                const { error: updateUserIdError } = await (supabase as any)
                    .from('access_tokens')
                    .update({ userId: userId })
                    .eq('token', accessToken);
                
                if (updateUserIdError) {
                    console.error('❌ Update userId error:', updateUserIdError);
                    return res.status(500).json({ message: 'Database error' });
                }
                console.log('✅ Token userId updated successfully');
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
                console.log('✅ Token created successfully');
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
        console.log('🔍 Getting user data for userId:', userId);

        try {
            const tokenRow = await getFacebookToken(userId);
            console.log('🔍 Token retrieved for user:', userId);

            // Récupérer les données de base de Facebook avec gestion d'erreur
            let userData = {};
            try {
                userData = await fetchFbGraph(tokenRow.token, 'me?fields=id,name,email');
                console.log('✅ User data retrieved successfully');
            } catch (error) {
                console.error('❌ Error fetching user data:', error);
                // Continuer avec des données vides
            }

            // Récupérer les comptes publicitaires avec gestion d'erreur
            let adAccounts = [];
            try {
                const accountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name,account_status,currency,amount_spent');
                adAccounts = accountsData.data || [];
                console.log('✅ Ad accounts retrieved:', adAccounts.length, 'accounts');
            } catch (error) {
                console.error('❌ Error fetching ad accounts:', error);
                // Continuer avec une liste vide
            }

            // Récupérer les pages avec gestion d'erreur
            let pages = [];
            try {
                const pagesData = await fetchFbGraph(tokenRow.token, 'me/accounts?fields=id,name,category');
                pages = pagesData.data || [];
                console.log('✅ Pages retrieved:', pages.length, 'pages');
            } catch (error) {
                console.error('❌ Error fetching pages:', error);
                // Continuer avec une liste vide
            }

            // Récupérer les business managers avec gestion d'erreur
            let business = [];
            try {
                const businessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name,timezone_name');
                business = businessData.data || [];
                console.log('✅ Business managers retrieved:', business.length, 'managers');
            } catch (error) {
                console.error('❌ Error fetching business managers:', error);
                // Si erreur de limite de requêtes, essayer avec des champs de base
                if (error.message && error.message.includes('Application request limit reached')) {
                    console.log('⚠️ Rate limit reached, trying with basic fields...');
                    try {
                        const basicBusinessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name');
                        business = basicBusinessData.data || [];
                        console.log('✅ Business managers retrieved with basic fields:', business.length, 'managers');
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

            console.log('✅ Facebook data prepared successfully');
            await createLog(userId, "USER_DATA_RETRIEVED", { userData, adAccountsCount: adAccounts.length });
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

            // Récupérer les comptes publicitaires
            let adAccounts = [];
            try {
                const accountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name,account_status,currency');
                adAccounts = accountsData.data || [];
            } catch (error) {
                // Ignore error for ad accounts
            }

            await createLog(userId, "FB_DATA_RETRIEVED", { fbData, adAccounts });
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

        await createLog(userId, "AD_ACCOUNTS_RETRIEVED", { accounts });
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

        // Construire l'endpoint avec les champs nécessaires
        const endpoint = `${accountId}/campaigns?fields=id,name,status,effective_status,objective,created_time,updated_time`;

        console.log(`🔍 Fetching campaigns for account ${accountId} with endpoint: ${endpoint}`);
        console.log(`🔍 Using token: ${tokenRow.token.substring(0, 20)}...`);
        
        let campaignsData = [];

        try {
        const campaigns = await fetchFbGraph(tokenRow.token, endpoint);
            console.log(`🔍 Facebook API response:`, campaigns);
            
            // Retourner les campagnes avec le format attendu par le frontend
            campaignsData = campaigns.data?.map(campaign => ({
                id: campaign.id,
                name: campaign.name,
                status: campaign.status,
                effective_status: campaign.effective_status,
                objective: campaign.objective,
                created_time: campaign.created_time,
                updated_time: campaign.updated_time
            })) || [];

            console.log(`📊 Found ${campaignsData.length} real campaigns for account ${accountId}`);
        } catch (fbError: any) {
            console.error(`❌ Facebook API error for account ${accountId}:`, fbError.message);
            
            // Si le token est invalide, retourner une erreur spécifique
            if (fbError.response?.data?.error?.code === 190) {
                return res.status(401).json({
                    success: false,
                    message: "Facebook token expired or invalid. Please reconnect your Facebook account.",
                    error: "TOKEN_EXPIRED",
                    accountId: accountId
                });
            }
            
            // Pour les autres erreurs, les propager
            throw fbError;
        }

        // Filtrer par statut si fourni
        if (status) {
            // Gérer le cas où status est une chaîne séparée par des virgules
            let statusArray = [];
            if (typeof status === 'string') {
                statusArray = status.split(',').map(s => s.trim());
            } else if (Array.isArray(status)) {
                statusArray = status;
            } else {
                statusArray = [status];
            }
            
            console.log(`🔍 Filtering campaigns by status:`, statusArray);
            campaignsData = campaignsData.filter(campaign => 
                statusArray.includes(campaign.effective_status)
            );
            console.log(`📊 After status filter: ${campaignsData.length} campaigns`);
        }

        console.log(`📊 Final result: ${campaignsData.length} campaigns for account ${accountId}`);
        
        await createLog(userId, "CAMPAIGNS_RETRIEVED", { accountId, campaignsCount: campaignsData.length });
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

        await createLog(userId, "INSIGHTS_RETRIEVED", { accountId, insightsData });
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
        const { campaignId } = req.params;
        
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les ad sets de la campagne
        const endpoint = `${campaignId}/adsets?fields=id,name,status,created_time,updated_time`;
        const adsets = await fetchFbGraph(tokenRow.token, endpoint);

        await createLog(userId, "ADSETS_RETRIEVED", { campaignId, adsets });
        return res.json({ adsets: adsets.data || [] });

    } catch (error: any) {
        return res.status(500).json({ 
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
}

// GET /api/facebook/adsets/:adsetId/ads - Récupérer les annonces
export async function getAdsetAds(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { adsetId } = req.params;
        
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les annonces de l'ad set
        const endpoint = `${adsetId}/ads?fields=id,name,status,created_time,updated_time,creative{id,name,title,body,call_to_action_type,image_url,link_url}`;
        const ads = await fetchFbGraph(tokenRow.token, endpoint);

        await createLog(userId, "ADS_RETRIEVED", { adsetId, ads });
        return res.json({ ads: ads.data || [] });

    } catch (error: any) {
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
        const tokenRow = await getFacebookToken(userId);

        if (!status) {
            return res.status(400).json({ message: "Status is required" });
        }

        // Mettre à jour le statut de l'annonce via l'API Facebook
        const response = await axios.post(
            `https://graph.facebook.com/v18.0/${adId}`,
            { status },
            {
                headers: {
                    'Authorization': `Bearer ${tokenRow.token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        await createLog(userId, "AD_STATUS_UPDATED", { adId, status, response: response.data });
        return res.json({ message: "Ad status updated successfully", data: response.data });

    } catch (error: any) {
        console.error('Error updating ad status:', error);
        return res.status(500).json({ message: error.message || "Server error" });
    }
}

// GET /api/facebook/analytics - Récupérer toutes les analytics complètes
export async function getCompleteAnalytics(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const tokenRow = await getFacebookToken(userId);

        console.log('🔍 Getting complete analytics for user:', userId);
        console.log('🔍 Token available:', tokenRow.token ? 'Yes' : 'No');

        // Utiliser la même logique que l'endpoint qui fonctionne
        // D'abord, récupérer les données de base comme dans getUserData
        let baseData = null;
        try {
            console.log('🔍 Fetching base Facebook data...');
            const userData = await fetchFbGraph(tokenRow.token, 'me?fields=id,name,email');
            const adAccountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name,account_status,currency,amount_spent');
            
            baseData = {
                user: userData,
                adAccounts: adAccountsData.data || [],
                pages: [],
                tokenInfo: { valid: true }
            };
            console.log('✅ Base data retrieved:', {
                user: baseData.user,
                adAccountsCount: baseData.adAccounts.length
            });
        } catch (error) {
            console.log('⚠️ Error fetching base data:', error);
        }

        // Récupérer les Business Managers
        let businessManagers = [];
        try {
            const businessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name,timezone_name,primary_page{id,name}');
            businessManagers = businessData.data || [];
            console.log('✅ Business Managers retrieved:', businessManagers.length);
        } catch (error) {
            console.log('⚠️ No business managers found or error:', error);
        }

        // Utiliser les comptes publicitaires de baseData si disponibles, sinon essayer de les récupérer
        let adAccounts = [];
        if (baseData && baseData.adAccounts && baseData.adAccounts.length > 0) {
            console.log('✅ Using ad accounts from base data:', baseData.adAccounts.length);
            adAccounts = baseData.adAccounts;
        } else {
            try {
                console.log('🔍 Fetching ad accounts directly...');
                const accountsData = await fetchFbGraph(tokenRow.token, 
                    'me/adaccounts?fields=id,name,account_status,currency,amount_spent,balance,timezone_name,business{id,name}'
                );
                adAccounts = accountsData.data || [];
                console.log('✅ Ad Accounts retrieved:', adAccounts.length);
                console.log('🔍 Ad Accounts data:', JSON.stringify(adAccounts, null, 2));
            } catch (error) {
                console.log('⚠️ No ad accounts found or error:', error);
                console.log('🔍 Error details:', error.response?.data || error.message);
                
                // Essayer une approche alternative si la première échoue
                try {
                    console.log('🔍 Trying alternative ad accounts endpoint...');
                    const altAccountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts');
                    adAccounts = altAccountsData.data || [];
                    console.log('✅ Alternative Ad Accounts retrieved:', adAccounts.length);
                } catch (altError) {
                    console.log('⚠️ Alternative ad accounts also failed:', altError);
                }
            }
        }

        // Récupérer les pages Facebook
        let pages = [];
        try {
            const pagesData = await fetchFbGraph(tokenRow.token, 
                'me/accounts?fields=id,name,category,is_published,access_token'
            );
            pages = pagesData.data || [];
            console.log('✅ Pages retrieved:', pages.length);
        } catch (error) {
            console.log('⚠️ No pages found or error:', error);
        }

        // Récupérer les campagnes avec métriques pour chaque compte publicitaire
        let campaignsWithMetrics = [];
        let totalCampaigns = 0;
        let totalAdsets = 0;
        let totalAds = 0;
        let totalSpend = 0;
        let totalImpressions = 0;
        let totalClicks = 0;
        let totalConversions = 0;

        for (const account of adAccounts) {
            try {
                // Récupérer les campagnes du compte
                const campaignsData = await fetchFbGraph(tokenRow.token, 
                    `${account.id}/campaigns?fields=id,name,status,objective,created_time,updated_time,effective_status`
                );
                const campaigns = campaignsData.data || [];

                // Pour chaque campagne, récupérer les métriques
                for (const campaign of campaigns) {
                    try {
                        const insightsData = await fetchFbGraph(tokenRow.token, 
                            `${campaign.id}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions&date_preset=last_30d`
                        );
                        const insights = insightsData.data?.[0] || {};

                        campaignsWithMetrics.push({
                            ...campaign,
                            account_id: account.id,
                            account_name: account.name,
                            metrics: {
                                spend: parseFloat(insights.spend || 0),
                                impressions: parseInt(insights.impressions || 0),
                                clicks: parseInt(insights.clicks || 0),
                                reach: parseInt(insights.reach || 0),
                                frequency: parseFloat(insights.frequency || 0),
                                cpc: parseFloat(insights.cpc || 0),
                                cpm: parseFloat(insights.cpm || 0),
                                ctr: parseFloat(insights.ctr || 0),
                                conversions: parseInt(insights.conversions || 0)
                            }
                        });

                        // Récupérer les adsets de la campagne
                        try {
                            const adsetsData = await fetchFbGraph(tokenRow.token, 
                                `${campaign.id}/adsets?fields=id,name,status,created_time,updated_time`
                            );
                            const adsets = adsetsData.data || [];
                            totalAdsets += adsets.length;

                            // Pour chaque adset, récupérer les annonces
                            for (const adset of adsets) {
                                try {
                                    const adsData = await fetchFbGraph(tokenRow.token, 
                                        `${adset.id}/ads?fields=id,name,status,created_time,updated_time`
                                    );
                                    const ads = adsData.data || [];
                                    totalAds += ads.length;
                                } catch (error) {
                                    console.log('⚠️ Error getting ads for adset:', adset.id);
                                }
                            }
                        } catch (error) {
                            console.log('⚠️ Error getting adsets for campaign:', campaign.id);
                        }

                        // Accumuler les métriques
                        totalCampaigns++;
                        totalSpend += parseFloat(insights.spend || 0);
                        totalImpressions += parseInt(insights.impressions || 0);
                        totalClicks += parseInt(insights.clicks || 0);
                        totalConversions += parseInt(insights.conversions || 0);

                    } catch (error) {
                        console.log('⚠️ Error getting insights for campaign:', campaign.id);
                        // Ajouter la campagne sans métriques
                        campaignsWithMetrics.push({
                            ...campaign,
                            account_id: account.id,
                            account_name: account.name,
                            metrics: {
                                spend: 0,
                                impressions: 0,
                                clicks: 0,
                                reach: 0,
                                frequency: 0,
                                cpc: 0,
                                cpm: 0,
                                ctr: 0,
                                conversions: 0
                            }
                        });
                        totalCampaigns++;
                    }
                }
            } catch (error) {
                console.log('⚠️ Error getting campaigns for account:', account.id);
            }
        }

        // Calculer les métriques globales
        const globalMetrics = {
            totalCampaigns,
            totalAdsets,
            totalAds,
            totalSpend,
            totalImpressions,
            totalClicks,
            totalConversions,
            totalAdAccounts: adAccounts.length,
            totalPages: pages.length,
            totalBusinesses: businessManagers.length,
            ctr: totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0,
            cpc: totalClicks > 0 ? (totalSpend / totalClicks) : 0,
            cpm: totalImpressions > 0 ? (totalSpend / totalImpressions * 1000) : 0
        };

        const analyticsData = {
            business: businessManagers,
            adAccounts: adAccounts,
            pages: pages,
            campaigns: campaignsWithMetrics,
            metrics: globalMetrics,
            timestamp: new Date().toISOString()
        };

        await createLog(userId, "COMPLETE_ANALYTICS_RETRIEVED", { 
            businessCount: businessManagers.length,
            adAccountsCount: adAccounts.length,
            campaignsCount: totalCampaigns,
            totalSpend: totalSpend
        });

        return res.json({
            success: true,
            data: analyticsData,
            cached: false,
            cacheAge: 0
        });

    } catch (error: any) {
        console.error('Error getting complete analytics:', error);
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
                // Récupérer les insights du compte pour les 30 derniers jours
                const insightsData = await fetchFbGraph(tokenRow.token, 
                    `${account.id}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions&date_preset=last_30d`,
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
                
                console.log(`✅ Added metrics for account ${account.name}:`, {
                    spend: insights.spend || account.amount_spent,
                    clicks: insights.clicks,
                    impressions: insights.impressions,
                    ctr: insights.ctr
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

        await createLog(userId, "BUSINESS_ACCOUNTS_RETRIEVED", { businessId, accounts: accountsWithMetrics });
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

// GET /api/facebook/account/:accountId/analytics - Récupérer les analytics détaillées d'un compte publicitaire
export async function getAccountAnalytics(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { accountId } = req.params;
        const { dateRange = 'last_30d' } = req.query;
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les insights du compte
        const insightsData = await fetchFbGraph(tokenRow.token, 
            `${accountId}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions,cost_per_conversion&date_preset=${dateRange}`
        );

        // Récupérer les campagnes avec métriques
        const campaignsData = await fetchFbGraph(tokenRow.token, 
            `${accountId}/campaigns?fields=id,name,status,objective,created_time,updated_time,effective_status`
        );

        let campaignsWithMetrics = [];
        for (const campaign of campaignsData.data || []) {
            try {
                const campaignInsights = await fetchFbGraph(tokenRow.token, 
                    `${campaign.id}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions&date_preset=${dateRange}`
                );
                const insights = campaignInsights.data?.[0] || {};

                campaignsWithMetrics.push({
                    ...campaign,
                    metrics: {
                        spend: parseFloat(insights.spend || 0),
                        impressions: parseInt(insights.impressions || 0),
                        clicks: parseInt(insights.clicks || 0),
                        reach: parseInt(insights.reach || 0),
                        frequency: parseFloat(insights.frequency || 0),
                        cpc: parseFloat(insights.cpc || 0),
                        cpm: parseFloat(insights.cpm || 0),
                        ctr: parseFloat(insights.ctr || 0),
                        conversions: parseInt(insights.conversions || 0)
                    }
                });
            } catch (error) {
                console.log('⚠️ Error getting insights for campaign:', campaign.id);
                campaignsWithMetrics.push({
                    ...campaign,
                    metrics: {
                        spend: 0,
                        impressions: 0,
                        clicks: 0,
                        reach: 0,
                        frequency: 0,
                        cpc: 0,
                        cpm: 0,
                        ctr: 0,
                        conversions: 0
                    }
                });
            }
        }

        const accountAnalytics = {
            accountId: accountId,
            insights: insightsData.data?.[0] || {},
            campaigns: campaignsWithMetrics,
            dateRange: dateRange,
            timestamp: new Date().toISOString()
        };

        await createLog(userId, "ACCOUNT_ANALYTICS_RETRIEVED", { accountId, campaignsCount: campaignsWithMetrics.length });
        return res.json({
            success: true,
            data: accountAnalytics
        });

    } catch (error: any) {
        console.error('Error getting account analytics:', error);
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
