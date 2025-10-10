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

// Fonction utilitaire pour appeler l'API Facebook
export async function fetchFbGraph(accessToken: string, endpoint: string = 'me') {
    try {
        console.log('🔍 fetchFbGraph called with:', {
            endpoint,
            accessToken: accessToken ? accessToken.substring(0, 10) + '...' : 'undefined'
        });

        const response = await axios.get(
            `https://graph.facebook.com/v18.0/${endpoint}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ fetchFbGraph success:', response.data);
        return response.data;
    } catch (error: any) {
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
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
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
                const { error: updateUserIdError } = await supabase
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

        try {
            const tokenRow = await getFacebookToken(userId);

            // Récupérer les données de base de Facebook
            const userData = await fetchFbGraph(tokenRow.token, 'me?fields=id,name,email');

            // Récupérer les comptes publicitaires
            let adAccounts = [];
            try {
                const accountsData = await fetchFbGraph(tokenRow.token, 'me/adaccounts?fields=id,name,account_status,currency,amount_spent');
                adAccounts = accountsData.data || [];
                console.log('✅ Ad accounts retrieved:', adAccounts.length, 'accounts');
                console.log('🔍 Ad accounts data:', JSON.stringify(adAccounts, null, 2));
            } catch (error) {
                console.error('❌ Error fetching ad accounts:', error);
                // Ne pas ignorer l'erreur, la logger
            }

            // Récupérer les pages
            let pages = [];
            try {
                const pagesData = await fetchFbGraph(tokenRow.token, 'me/accounts?fields=id,name,category');
                pages = pagesData.data || [];
            } catch (error) {
                // Ignore error for pages
            }

            // Récupérer les business managers
            let business = [];
            try {
                const businessData = await fetchFbGraph(tokenRow.token, 'me/businesses?fields=id,name,timezone_name');
                business = businessData.data || [];
            } catch (error) {
                // Ignore error for business
            }

            const facebookData = {
                user: userData,
                adAccounts: adAccounts,
                pages: pages,
                business: business,
                tokenInfo: { valid: true }
            };

            await createLog(userId, "USER_DATA_RETRIEVED", { userData, adAccountsCount: adAccounts.length });
            return res.json({
                success: true,
                data: facebookData
            });
        } catch (tokenError: any) {
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
        console.error('Error getting user data:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error" 
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

        // Vérifier le format de l'accountId
        if (!accountId || accountId.length < 5) {
            return res.status(400).json({
                message: "Invalid account ID",
                accountId: accountId
            });
        }

        const tokenRow = await getFacebookToken(userId);

        // Récupérer les campagnes du compte (seulement les champs disponibles sur Campaign)
        const endpoint = `${accountId}/campaigns?fields=id,name,status,objective,created_time,updated_time`;
        const campaigns = await fetchFbGraph(tokenRow.token, endpoint);

        // Retourner les campagnes sans métriques pour éviter l'erreur impressions
        const campaignsWithMetrics = campaigns.data?.map(campaign => ({
            ...campaign,
            account_id: accountId,
            daily_budget: 0,
            lifetime_budget: 0,
            start_time: campaign.created_time,
            end_time: null,
            impressions: 0,
            clicks: 0,
            spend: 0,
            reach: 0,
            conversions: 0,
            ctr: 0,
            cpc: 0,
            conversion_rate: 0
        })) || [];

        await createLog(userId, "CAMPAIGNS_RETRIEVED", { accountId, campaignsCount: campaignsWithMetrics.length });
        return res.json({ campaigns: campaignsWithMetrics });

    } catch (error: any) {
        return res.status(500).json({
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

        // Récupérer les comptes publicitaires du Business Manager
        const accountsData = await fetchFbGraph(tokenRow.token, 
            `${businessId}/owned_ad_accounts?fields=id,name,account_status,currency,amount_spent,balance,timezone_name`
        );

        await createLog(userId, "BUSINESS_ACCOUNTS_RETRIEVED", { businessId, accounts: accountsData.data });
        return res.json({ 
            success: true,
            accounts: accountsData.data || [],
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
