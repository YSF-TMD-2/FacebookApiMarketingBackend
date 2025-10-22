import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import { createSchedule, getSchedules, deleteSchedule } from "../controllers/scheduleController.js";
import { Request, Response } from "../types/express.js";

const router = Router();

// Créer un schedule pour une ad
router.post("/ad/:adId", protect, createSchedule);

// Récupérer tous les schedules de l'utilisateur
router.get("/", protect, getSchedules);

// Supprimer un schedule
router.delete("/:scheduleId", protect, deleteSchedule);

export default router;
