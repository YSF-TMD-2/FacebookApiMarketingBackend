import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { saveAccessToken, getFbData, getAdAccounts, getAccountCampaigns, getCampaignAdsets, getAdsetAds, updateAdStatus, disconnectFacebook, clearFacebookCache, getFacebookToken, fetchFbGraph } from "../controllers/facebookController.js";
import { Request, Response } from "../types/express.js";

const router = Router();
// store access token (sent by frontend), fetch FB data and cache

router.post('/token' , protect , saveAccessToken)

// get cached FB data for current user
router.get("/data", protect, getFbData);

// get Facebook ad accounts
router.get("/accounts", protect, getAdAccounts);

// get campaigns for a specific ad account
router.get("/campaigns/:accountId", protect, getAccountCampaigns);


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

// Handle preflight requests for PUT
router.options("/ads/:adId/status", (req: Request, res: Response) => {
    res.header('Access-Control-Allow-Origin', typeof req.headers?.origin === 'string' ? req.headers.origin : '');
    res.header('Access-Control-Allow-Methods', 'PUT, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.sendStatus(200);
});

export default router;