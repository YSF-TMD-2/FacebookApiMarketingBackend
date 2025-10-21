import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { saveAccessToken, getUserData, getFbData, getAdAccounts, getAccountCampaigns, getAccountInsights, getCampaignAdsets, getAdsetAds, updateAdStatus, disconnectFacebook, clearFacebookCache, abortFacebookRequests, getFacebookToken, fetchFbGraph, getCompleteAnalytics, getBusinessAdAccounts, getAccountAnalytics, facebookDiagnostic, testFacebookSimple, testAdAccounts, handleOAuthCallback } from "../controllers/facebookController.js";
import { Request, Response } from "../types/express.js";

const router = Router();
// store access token (sent by frontend), fetch FB data and cache

// OAuth callback route
router.post('/oauth/callback', handleOAuthCallback);

router.post('/token' , saveAccessToken)

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
        
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les détails de l'adset
        const endpoint = `${adsetId}?fields=id,name,status,created_time,updated_time,daily_budget,lifetime_budget,start_time,end_time`;
        const adsetDetails = await fetchFbGraph(tokenRow.token, endpoint);

        return res.json({ 
            success: true,
            data: adsetDetails,
            message: "Adset details retrieved successfully"
        });

    } catch (error: any) {
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
});

// get ad details
router.get("/ad/:adId", protect, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.id;
        const { adId } = req.params;
        
        const tokenRow = await getFacebookToken(userId);

        // Récupérer les détails de l'ad avec les insights
        const endpoint = `${adId}?fields=id,name,status,created_time,updated_time,creative,adset_id,campaign_id,insights{impressions,clicks,spend,reach,ctr,cpc,conversions}`;
        const adDetails = await fetchFbGraph(tokenRow.token, endpoint);

        return res.json({ 
            success: true,
            data: adDetails,
            message: "Ad details retrieved successfully"
        });

    } catch (error: any) {
        return res.status(500).json({ 
            success: false,
            message: error.message || "Server error",
            details: error.response?.data || null
        });
    }
});

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

// Analytics endpoints
router.get("/analytics", protect, getCompleteAnalytics);
router.get("/business/:businessId/accounts", protect, getBusinessAdAccounts);
router.get("/account/:accountId/analytics", protect, getAccountAnalytics);

// Diagnostic endpoints
router.get("/test-simple", protect, testFacebookSimple);
router.get("/test-accounts", protect, testAdAccounts);
router.get("/diagnostic", protect, facebookDiagnostic);

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