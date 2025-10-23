import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { createSchedule, testExecuteSchedules, createTestSchedule, createTestTimeRangeSchedule, debugSchedules, createImmediateTestSchedule, forceExecuteSchedule, getScheduleAnalytics } from "../controllers/scheduleController.js";
import { Request, Response } from "../types/express.js";

const router = Router();

// Créer un schedule pour une ad
router.post("/ad/:adId", protect, createSchedule);


// Tester l'exécution des schedules (pour debug)
router.post("/test-execute", protect, testExecuteSchedules);

// Créer un schedule de test (date dans le passé pour exécution immédiate)
router.post("/test-schedule/:adId", protect, createTestSchedule);

// Créer un schedule de test avec plage horaire
router.post("/test-time-range/:adId", protect, createTestTimeRangeSchedule);

// Debug - afficher tous les schedules en cours
router.get("/debug", protect, debugSchedules);

// Créer un schedule de test immédiat
router.post("/test-immediate/:adId", protect, createImmediateTestSchedule);

// Forcer l'exécution immédiate d'un schedule
router.post("/force-execute/:adId", protect, forceExecuteSchedule);

// Récupérer les analytics des schedules
router.get("/analytics", protect, getScheduleAnalytics);

export default router;
