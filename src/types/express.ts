declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string; // Supabase utilise des UUIDs (strings)
                name: string;
                email: string;
                email_confirmed?: boolean;
            };
            ip?: string;
            connection?: {
                remoteAddress?: string;
            };
            params?: Record<string, string>;
            body?: any;
            query?: any;
            headers?: Record<string, string | string[] | undefined>;
        }
    }
}

// Types pour les paramètres de route
export interface Request {
    user?: {
        id: string; // Supabase utilise des UUIDs (strings)
        name: string;
        email: string;
        email_confirmed?: boolean;
    };
    headers?: Record<string, string | string[] | undefined>;
    body?: any;
    params?: Record<string, string>;
    query?: any;
    method?: string;
    url?: string;
    path?: string;
    ip?: string;
    connection?: {
        remoteAddress?: string;
    };
}

export interface Response {
    json: (data: any) => Response;
    status: (code: number) => Response;
    send: (data: any) => Response;
    sendStatus: (code: number) => Response;
    header: (name: string, value: string) => Response;
}

export interface NextFunction {
    (): void;
    (error?: any): void;
}

export interface AuthRequest extends Request {
    user?: {
        id: string; // Supabase utilise des UUIDs (strings)
        name: string;
        email: string;
        email_confirmed?: boolean;
    };
}