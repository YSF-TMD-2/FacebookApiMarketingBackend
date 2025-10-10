import { Router } from "express";
import { 
    getMe, 
    loginUser, 
    registerUser, 
    changePassword, 
    logoutUser, 
    refreshToken 
} from "../controllers/authController.js";
import protect from "../middleware/authMiddleware.js";
import { Request, Response } from "../types/express.js";

// Configuration du router pour les appels API
const router = Router();

// Routes d'authentification avec Supabase Auth
router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/logout", logoutUser);
router.post("/refresh", refreshToken);
router.get("/me", protect, getMe);
router.put("/change-password", protect, changePassword);

// Route de test
router.get("/test", (req: Request, res: Response) => {
    return res.json({
        message: "Auth routes working with Supabase",
        timestamp: new Date().toISOString()
    });
});

export default router;