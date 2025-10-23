import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { cleanupLogs, getLogStats } from "../controllers/logsController.js";

const router = Router();

// Nettoyer les logs inutiles
router.post("/cleanup", protect, cleanupLogs);

// Récupérer les statistiques des logs
router.get("/stats", protect, getLogStats);

export default router;
