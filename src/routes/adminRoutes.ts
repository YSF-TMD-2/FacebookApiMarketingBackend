import express from 'express';
import protect from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/roleMiddleware.js';
import {
  getAllUsers,
  getUserDetails,
  getSystemSettings,
  updateSystemSettings,
  toggleBatch,
  getBatchStatus,
  getAllQuotas,
  updateUserBatchConfig,
  getAllRegisteredUsers,
  getAllStopLossAds,
  deleteUser,
  toggleUserStatus,
  resetUserPassword,
  getAdDetailsForAdmin
} from '../controllers/adminController.js';

const router = express.Router();

// Toutes les routes admin nécessitent authentification + rôle admin
router.use(protect);
router.use(requireAdmin);

// Routes utilisateurs
router.get('/users', getAllUsers);
router.get('/users/registered', getAllRegisteredUsers); // Tous les utilisateurs inscrits
router.get('/users/:userId/details', getUserDetails);
router.patch('/users/:userId/batch-config', updateUserBatchConfig);
router.delete('/users/:userId', deleteUser); // Supprimer un utilisateur
router.patch('/users/:userId/status', toggleUserStatus); // Désactiver/Activer un utilisateur
router.post('/users/:userId/reset-password', resetUserPassword); // Réinitialiser le mot de passe

// Routes stop-loss ads
// IMPORTANT: Les routes plus spécifiques doivent être définies AVANT les routes génériques
router.get('/stop-loss-ads/:adId/details', getAdDetailsForAdmin); // Détails d'une annonce avec métriques
router.get('/stop-loss-ads', getAllStopLossAds); // Toutes les ads avec stop-loss actif

// Routes paramètres système
router.get('/settings', getSystemSettings);
router.put('/settings', updateSystemSettings);

// Routes batch
router.get('/batch/status', getBatchStatus);
router.post('/batch/toggle', toggleBatch);

// Routes quotas
router.get('/quotas', getAllQuotas);

export default router;

