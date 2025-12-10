import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { saveAccessToken, getUserData, getFbData, getAdAccounts, getAccountCampaigns, getAccountInsights, getCampaignAdsets, getAdsetAds, updateAdStatus, disconnectFacebook, clearFacebookCache, abortFacebookRequests, getFacebookToken, fetchFbGraph, getBusinessAdAccounts, facebookDiagnostic, testFacebookSimple, testAdAccounts, handleOAuthCallback, getAccountTotalSpend, getAdDetails } from "../controllers/facebookController.js";
import { Request, Response } from "../types/express.js";

const router = Router();
// store access token (sent by frontend), fetch FB data and cache

// OAuth callback route
router.post('/oauth/callback', handleOAuthCallback);

// Sauvegarder le token Facebook (nécessite authentification)
router.post('/token', protect, saveAccessToken)

// get user Facebook data
router.get("/user-data", protect, getUserData);

// get cached FB data for current user
router.get("/data", protect, getFbData);

// get Facebook ad accounts
router.get("/accounts", protect, getAdAccounts);

// get campaigns for a specific ad account
router.get("/campaigns/:accountId", protect, getAccountCampaigns);

// get campaigns for a specific ad account (new format)
router.get("/account/:accountId/campaigns", protect, getAccountCampaigns);

// get ads insights for a specific ad account
router.get("/account/:accountId/insights", protect, getAccountInsights);

// get total spend for a specific ad account (all campaigns with date range)
router.get("/account/:accountId/total-spend", protect, getAccountTotalSpend);

// get insights for a specific campaign
router.get("/campaign/:campaignId/insights", protect, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.id;
        const { campaignId } = req.params;
        const { dateRange = 'last_30d' } = req.query;
        
        const tokenRow = await getFacebookToken(userId);
        
        // Récupérer les insights de la campagne
        const endpoint = `${campaignId}/insights?fields=spend,impressions,clicks,conversions,ctr,cpc,cpm&date_preset=${dateRange}`;
        const insights = await fetchFbGraph(tokenRow.token, endpoint);
        
        return res.json({
            success: true,
            data: insights.data || [],
            message: "Campaign insights retrieved successfully"
        });
        
    } catch (error: any) {
        console.error('Get campaign insights failed:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
});


// get adsets for a specific campaign
router.get("/adsets/:campaignId", protect, getCampaignAdsets);

// get ads for a specific adset
router.get("/ads/:adsetId", protect, getAdsetAds);

// get adset details
router.get("/adset/:adsetId", protect, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.id;
        const { adsetId } = req.params;
        
        console.log('🔍 getAdsetDetails called with adsetId:', adsetId);
        
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les détails de base de l'adset
        const endpoint = `${adsetId}?fields=id,name,status,created_time,updated_time,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,bid_strategy,billing_event`;
        const adsetDetails = await fetchFbGraph(tokenRow.token, endpoint);
        console.log('🔍 Adset basic details:', adsetDetails);

        // Récupérer les métriques de l'adset
        let adsetMetrics = {};
        try {
            const insightsEndpoint = `${adsetId}/insights?fields=spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,conversions&date_preset=last_30d`;
            const insights = await fetchFbGraph(tokenRow.token, insightsEndpoint);
            const insightData = insights.data?.[0] || {};
            
            adsetMetrics = {
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
            };
            console.log('🔍 Adset metrics:', adsetMetrics);
        } catch (insightsError) {
            console.log('⚠️ Error fetching adset insights:', insightsError.message);
            // Utiliser des valeurs par défaut en cas d'erreur
            adsetMetrics = {
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
            ...adsetDetails,
            ...adsetMetrics
        };

        return res.json({ 
            success: true,
            data: combinedData,
            message: "Adset details retrieved successfully"
        });

    } catch (error: any) {
        console.error('❌ Error in getAdsetDetails:', error);
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
});

// get ad details
router.get("/ad/:adId", protect, getAdDetails);

// update ad status (pause/activate)
router.put("/ads/:adId/status", protect, updateAdStatus);

// disconnect Facebook account
router.delete("/disconnect", protect, disconnectFacebook);

// clear Facebook cache
router.post("/clear-cache", protect, clearFacebookCache);

// clear Facebook cache for specific account
router.post("/account/:accountId/clear-cache", protect, clearFacebookCache);

// abort Facebook requests
router.post("/abort-requests", protect, abortFacebookRequests);

// Business Manager endpoints
router.get("/business/:businessId/accounts", protect, getBusinessAdAccounts);

// Diagnostic endpoints
router.get("/test-simple", protect, testFacebookSimple);
router.get("/test-accounts", protect, testAdAccounts);
router.get("/diagnostic", protect, facebookDiagnostic);

// Proxy pour les images Facebook
router.get("/image-proxy", protect, async (req: Request, res: Response) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                message: "URL parameter is required"
            });
        }

        console.log('🔍 Proxying image URL:', url);

        const tokenRow = await getFacebookToken(req.user!.id);
        
        // Faire la requête à Facebook avec le token et des headers plus complets
        const response = await fetch(url as string, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${tokenRow.token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': 'https://www.facebook.com/',
                'Sec-Fetch-Dest': 'image',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'same-origin'
            },
            redirect: 'follow'
        });

        console.log('🔍 Facebook response status:', response.status);

        if (!response.ok) {
            console.error('❌ Facebook API error:', response.status, response.statusText);
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const imageBuffer = await response.arrayBuffer();
        console.log('✅ Image buffer size:', imageBuffer.byteLength);
        
        // Définir les headers pour l'image
        res.header('Content-Type', response.headers.get('content-type') || 'image/jpeg');
        res.header('Content-Length', imageBuffer.byteLength.toString());
        res.header('Cache-Control', 'public, max-age=86400'); // 24 heures
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        res.send(Buffer.from(imageBuffer));
        
    } catch (error: any) {
        console.error('❌ Error proxying image:', error);
        res.status(500).json({
            success: false,
            message: "Failed to load image",
            error: error.message
        });
    }
});

// Test endpoint pour vérifier l'authentification
router.get("/test-auth", protect, (req: Request, res: Response) => {
    res.json({
        success: true,
        message: "Authentication successful",
        user: req.user
    });
});

// Handle preflight requests for PUT
router.options("/ads/:adId/status", (req: Request, res: Response) => {
    res.header('Access-Control-Allow-Origin', typeof req.headers?.origin === 'string' ? req.headers.origin : '');
    res.header('Access-Control-Allow-Methods', 'PUT, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.sendStatus(200);
});

export default router;