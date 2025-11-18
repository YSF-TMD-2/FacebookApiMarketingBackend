import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { createSchedule, testExecuteSchedules, createTestSchedule, createTestTimeRangeSchedule, debugSchedules, createImmediateTestSchedule, forceExecuteSchedule, getScheduleAnalytics, getAdSchedules, deleteAdSchedules, getAllScheduledAds, deleteSchedule, getCalendarSchedule, createCalendarSchedule, updateCalendarSchedule, deleteCalendarScheduleDate, deleteCalendarSchedule } from "../controllers/scheduleController.js";
import { getCalendarScheduleHistory, deleteCalendarScheduleHistory, getAllCalendarSchedules } from "../controllers/calendarScheduleController.js";
import { Request, Response } from "../types/express.js";

const router = Router();

// Créer un schedule pour une ad
router.post("/ad/:adId", protect, createSchedule);

// Routes pour Calendar Schedules (optimisées pour grandes quantités d'ads)
// IMPORTANT: Ces routes doivent être déclarées AVANT les routes génériques pour éviter les conflits
router.get("/calendar/:adId", protect, getCalendarSchedule);
router.get("/calendar/:adId/all", protect, getAllCalendarSchedules);
router.get("/calendar/:adId/history", protect, getCalendarScheduleHistory);
router.delete("/calendar/:adId/history", protect, deleteCalendarScheduleHistory);
router.post("/calendar/:adId", protect, createCalendarSchedule);
router.put("/calendar/:adId", protect, updateCalendarSchedule);
router.delete("/calendar/:adId/date/:date", protect, deleteCalendarScheduleDate);
router.delete("/calendar/:adId", protect, deleteCalendarSchedule);

// Récupérer les schedules actifs d'une ad
router.get("/ad/:adId", protect, getAdSchedules);

// Supprimer les schedules d'une ad
router.delete("/ad/:adId", protect, deleteAdSchedules);

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

// Récupérer toutes les ads avec des schedules actifs
router.get("/ads", protect, getAllScheduledAds);

// Supprimer un schedule spécifique par son ID (doit être en dernier pour éviter les conflits)
router.delete("/:scheduleId", protect, deleteSchedule);

export default router;
