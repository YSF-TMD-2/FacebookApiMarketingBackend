import { Router } from "express";
import protect from "../middleware/authMiddleware.js";
import {
  getMyStopLoss,
  getMyStopLossDetails,
  toggleMyStopLoss,
  updateMyStopLossThresholds,
  deleteMyStopLoss
} from "../controllers/myStopLossController.js";

const router = Router();

// Tous les endpoints nécessitent l'authentification
// Le middleware protect garantit que req.user est défini

// Récupérer tous les stop-loss de l'utilisateur connecté
router.get("/", protect, getMyStopLoss);

// Récupérer les détails d'un stop-loss spécifique
router.get("/:adId", protect, getMyStopLossDetails);

// Enable/Disable un stop-loss
router.patch("/:adId/toggle", protect, toggleMyStopLoss);

// Mettre à jour les seuils d'un stop-loss
router.patch("/:adId/thresholds", protect, updateMyStopLossThresholds);

// Supprimer un stop-loss
router.delete("/:adId", protect, deleteMyStopLoss);

export default router;

