import { Router } from "express";
import { authenticateToken } from "../middleware/authMiddleware.js";
import {
    createNotification,
    getNotifications,
    markNotificationAsRead,
    deleteNotification,
    deleteAllNotifications,
    getNotificationStats
} from "../controllers/notificationController.js";

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Créer une notification
router.post('/', createNotification);

// Récupérer les notifications d'un utilisateur
router.get('/', getNotifications);

// Obtenir les statistiques des notifications
router.get('/stats', getNotificationStats);

// Marquer une notification comme lue
router.patch('/:notificationId/read', markNotificationAsRead);

// Supprimer une notification
router.delete('/:notificationId', deleteNotification);

// Supprimer toutes les notifications
router.delete('/', deleteAllNotifications);

export default router;
