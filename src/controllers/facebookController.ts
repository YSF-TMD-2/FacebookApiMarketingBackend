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
        const response = await axios.get(
            `https://graph.facebook.com/v18.0/${endpoint}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error: any) {
        throw error;
    }
}

// POST /api/facebook/token - Sauvegarder le token Facebook
export async function saveAccessToken(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { accessToken } = req.body;

        if (!accessToken) {
            return res.status(400).json({ message: "Access token is required" });
        }

        // Vérifier si un token existe déjà
        const { data: existingToken } = await supabase
            .from('access_tokens')
            .select('*')
            .eq('userId', userId)
            .single();

        // Valider le token avec Facebook
        let fbData = null;
        try {
            fbData = await fetchFbGraph(accessToken);
        } catch (error: any) {
            await createLog(userId, "UPLOAD_TOKEN_FAILED", {
                error: error?.message || error,
            });
            return res.status(400).json({ message: "Failed to validate access token with Facebook" });
        }

        // Créer ou mettre à jour le token
        if (existingToken) {
            const { error: updateError } = await (supabase as any)
                .from('access_tokens')
                .update({ token: accessToken })
                .eq('userId', userId);

            if (updateError) {
                return res.status(500).json({ message: 'Database error' });
            }
        } else {
            // Insertion directe avec Service Role (contourne RLS)
            const { error: insertError } = await supabase
                .from('access_tokens')
                .insert({
                    userId: userId,
                    token: accessToken
                } as any);

            if (insertError) {
                return res.status(500).json({ message: 'Database error' });
            }
        }

        await createLog(userId, "TOKEN_SAVED", { fbData });
        return res.json({ message: "Access token saved successfully", fbData });

    } catch (error: any) {
        console.error('Error saving access token:', error);
        return res.status(500).json({ message: error.message || "Server error" });
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

        // Récupérer les campagnes du compte
        const endpoint = `${accountId}/campaigns?fields=id,name,status,objective,created_time,updated_time`;
        const campaigns = await fetchFbGraph(tokenRow.token, endpoint);

        await createLog(userId, "CAMPAIGNS_RETRIEVED", { accountId, campaigns });
        return res.json({ campaigns: campaigns.data || [] });

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
