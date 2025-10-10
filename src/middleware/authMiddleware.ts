import { supabase } from "../supabaseClient.js";
import { AuthRequest, Response, NextFunction } from "../types/express.js";

const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        // Récupérer le token d'autorisation
        const authHeader = req.headers.authorization;
        
        if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ 
                message: "Not authorized, no token provided" 
            });
        }

        const token = authHeader.split(" ")[1];
        
        if (!token) {
            return res.status(401).json({ 
                message: "Not authorized, invalid token format" 
            });
        }

        // Vérifier le token avec Supabase Auth avec retry
        let user, error;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                const result = await supabase.auth.getUser(token);
                user = result.data.user;
                error = result.error;
                
                if (!error) break;
                
                // Si c'est une erreur réseau, retry
                if (error.message?.includes('fetch failed') || error.message?.includes('ECONNRESET')) {
                    retryCount++;
                    if (retryCount < maxRetries) {
                        console.log(`🔄 Retry ${retryCount}/${maxRetries} for Supabase Auth...`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                        continue;
                    }
                }
                break;
            } catch (networkError: any) {
                console.error(`❌ Network error (attempt ${retryCount + 1}):`, networkError.message);
                retryCount++;
                if (retryCount < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                    continue;
                }
                throw networkError;
            }
        }

        if (error || !user) {
            console.error("Supabase Auth error:", error);
            return res.status(401).json({ 
                message: "Invalid or expired token",
                details: error?.message || "Authentication failed"
            });
        }

        // Ajouter les informations utilisateur à la requête
        req.user = {
            id: user.id,
            email: user.email || '',
            name: user.user_metadata?.name || user.email || '',
            email_confirmed: !!user.email_confirmed_at
        };

        next();
    } catch (error) {
        console.error("Auth middleware error:", error);
        return res.status(401).json({ 
            message: "Authentication failed" 
        });
    }
};

export default protect;
