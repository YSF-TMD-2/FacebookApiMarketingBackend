import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { configureStopLoss, getStopLossConfigs, deleteStopLossConfig } from "../controllers/stopLossController.js";
import { Request, Response } from "../types/express.js";

const router = Router();

// Configurer le stop loss pour une ad
router.post("/ad/:adId", protect, configureStopLoss);

// Récupérer toutes les configurations stop loss de l'utilisateur
router.get("/", protect, getStopLossConfigs);

// Supprimer une configuration stop loss
router.delete("/ad/:adId", protect, deleteStopLossConfig);

export default router;
