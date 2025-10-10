
import { supabase } from "../supabaseClient.js";
import { Request, Response } from "../types/express.js";


// Gestion de register avec Supabase Auth
export const registerUser = async (req: Request, res: Response) => {
    const { name, email, password } = req.body;
    
    try {
        // Validation des données d'entrée
        if (!name || !email || !password) {
            return res.status(400).json({ 
                message: "Name, email and password are required" 
            });
        }

        if (password.length < 6) {
            return res.status(400).json({ 
                message: "Password must be at least 6 characters long" 
            });
        }

        // Inscription avec Supabase Auth
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    name: name
                }
            }
        });

        if (error) {
            console.error("Supabase Auth error:", error);
            return res.status(400).json({ 
                message: error.message 
            });
        }

        if (!data.user) {
            return res.status(500).json({ 
                message: "Failed to create user" 
            });
        }

        // Retourner les informations de l'utilisateur
        res.status(201).json({
            message: "User registered successfully",
            user: {
                id: data.user.id,
                email: data.user.email,
                name: data.user.user_metadata?.name || name,
                email_confirmed: data.user.email_confirmed_at ? true : false
            },
            session: data.session
        });

    } catch (error: unknown) {
        console.error("Error during register:", error);
        res.status(500).json({ 
            message: `Error during register: ${(error as Error).message}` 
        });
    }
}


// Gestion de login avec Supabase Auth
export const loginUser = async (req: Request, res: Response) => {
    const { email, password } = req.body;

    try {
        // Validation des données d'entrée
        if (!email || !password) {
            return res.status(400).json({ 
                message: "Email and password are required" 
            });
        }

        // Connexion avec Supabase Auth
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            console.error("Supabase Auth login error:", error);
            return res.status(401).json({ 
                message: "Invalid credentials" 
            });
        }

        if (!data.user) {
            return res.status(401).json({ 
                message: "Authentication failed" 
            });
        }

        // Retourner les informations de l'utilisateur
        res.json({
            message: "Login successful",
            user: {
                id: data.user.id,
                email: data.user.email,
                name: data.user.user_metadata?.name || data.user.email,
                email_confirmed: data.user.email_confirmed_at ? true : false
            },
            session: data.session
        });

    } catch (error: unknown) {
        console.error("Error during login:", error);
        res.status(500).json({ 
            message: `Error during login: ${(error as Error).message}` 
        });
    }
}


// Récupération de l'utilisateur actuel avec Supabase Auth
export const getMe = async (req: Request, res: Response) => {
    try {
        // L'utilisateur est déjà validé par le middleware
        const user = req.user;
        
        if (!user) {
            return res.status(401).json({ 
                message: "User not authenticated" 
            });
        }

        res.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                email_confirmed: user.email_confirmed || false
            },
            timestamp: new Date().toISOString()
        });

    } catch (error: unknown) {
        console.error("Error getting user:", error);
        res.status(500).json({ 
            message: `Error getting user: ${(error as Error).message}` 
        });
    }
}

// Changement de mot de passe avec Supabase Auth
export const changePassword = async (req: Request, res: Response) => {
    try {
        const { newPassword } = req.body;
        const user = req.user;

        if (!user) {
            return res.status(401).json({ 
                message: "User not authenticated" 
            });
        }

        // Validation des données d'entrée
        if (!newPassword) {
            return res.status(400).json({ 
                message: "New password is required" 
            });
        }

        // Validation de la force du nouveau mot de passe
        if (newPassword.length < 6) {
            return res.status(400).json({ 
                message: "New password must contain at least 6 characters" 
            });
        }

        // Mettre à jour le mot de passe avec Supabase Auth
        const { data, error } = await supabase.auth.updateUser({
            password: newPassword
        });

        if (error) {
            console.error('Error updating password:', error);
            return res.status(400).json({ 
                message: error.message 
            });
        }

        res.json({ 
            message: "Password changed successfully",
            user: {
                id: data.user?.id,
                email: data.user?.email
            }
        });

    } catch (error: unknown) {
        console.error("Error changing password:", error);
        res.status(500).json({ 
            message: `Error changing password: ${(error as Error).message}` 
        });
    }
}

// Déconnexion avec Supabase Auth
export const logoutUser = async (req: Request, res: Response) => {
    try {
        const { error } = await supabase.auth.signOut();

        if (error) {
            console.error('Error during logout:', error);
            return res.status(400).json({ 
                message: error.message 
            });
        }

        res.json({ 
            message: "Logout successful" 
        });

    } catch (error: unknown) {
        console.error("Error during logout:", error);
        res.status(500).json({ 
            message: `Error during logout: ${(error as Error).message}` 
        });
    }
}

// Rafraîchir le token de session
export const refreshToken = async (req: Request, res: Response) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({ 
                message: "Refresh token is required" 
            });
        }

        const { data, error } = await supabase.auth.refreshSession({
            refresh_token
        });

        if (error) {
            console.error('Error refreshing token:', error);
            return res.status(400).json({ 
                message: error.message 
            });
        }

        res.json({
            message: "Token refreshed successfully",
            session: data.session
        });

    } catch (error: unknown) {
        console.error("Error refreshing token:", error);
        res.status(500).json({ 
            message: `Error refreshing token: ${(error as Error).message}` 
        });
    }
}