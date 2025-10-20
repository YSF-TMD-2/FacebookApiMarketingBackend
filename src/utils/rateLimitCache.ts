// Cache simple pour éviter les appels API répétés
interface CacheEntry {
    data: any;
    timestamp: number;
    ttl: number; // Time to live en millisecondes
}

class RateLimitCache {
    private cache = new Map<string, CacheEntry>();
    private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes par défaut

    set(key: string, data: any, ttl: number = this.DEFAULT_TTL): void {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            ttl
        });
    }

    get(key: string): any | null {
        const entry = this.cache.get(key);
        if (!entry) return null;

        const now = Date.now();
        const age = now - entry.timestamp;

        if (age > entry.ttl) {
            this.cache.delete(key);
            return null;
        }

        return entry.data;
    }

    has(key: string): boolean {
        return this.get(key) !== null;
    }

    clear(): void {
        this.cache.clear();
    }

    // Nettoyer les entrées expirées
    cleanup(): void {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > entry.ttl) {
                this.cache.delete(key);
            }
        }
    }

    // Obtenir les statistiques du cache
    getStats() {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }
}

// Instance globale du cache
export const rateLimitCache = new RateLimitCache();

// Nettoyer le cache toutes les 10 minutes
setInterval(() => {
    rateLimitCache.cleanup();
}, 10 * 60 * 1000);

// Fonction utilitaire pour créer une clé de cache
export function createCacheKey(endpoint: string, params: any = {}): string {
    const sortedParams = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    
    return `${endpoint}${sortedParams ? `?${sortedParams}` : ''}`;
}

// Fonction pour wrapper les appels API avec cache
export async function cachedApiCall<T>(
    cacheKey: string,
    apiCall: () => Promise<T>,
    ttl: number = 5 * 60 * 1000
): Promise<T> {
    // Vérifier le cache d'abord
    const cached = rateLimitCache.get(cacheKey);
    if (cached) {
        console.log(`📦 Using cached data for: ${cacheKey}`);
        return cached;
    }

    // Si pas en cache, faire l'appel API
    console.log(`🌐 Making API call for: ${cacheKey}`);
    const result = await apiCall();
    
    // Mettre en cache
    rateLimitCache.set(cacheKey, result, ttl);
    
    return result;
}
