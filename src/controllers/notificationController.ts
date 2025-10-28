import { Request, Response } from "../types/express.js";
import { supabase } from "../supabaseClient.js";
import { getFacebookToken } from "./facebookController.js";

// Interface pour les notifications
interface NotificationData {
    id: string;
    userId: string;
    type: 'stop_loss' | 'info' | 'warning' | 'error';
    title: string;
    message: string;
    adId?: string;
    adName?: string;
    threshold?: number;
    actualValue?: number;
    read: boolean;
    createdAt: string;
}

// Créer une notification
export async function createNotification(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { type, title, message, adId, adName, threshold, actualValue } = req.body;

        console.log('🔔 Creating notification for user:', userId, 'Type:', type);

        // Valider les paramètres requis
        if (!type || !title || !message) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters: type, title, message"
            });
        }

        // Créer la notification dans la base de données
        const { data, error } = await supabase
            .from('notifications')
            .insert({
                user_id: userId,
                type,
                title,
                message,
                ad_id: adId,
                ad_name: adName,
                threshold,
                actual_value: actualValue,
                read: false
            })
            .select()
            .single();

        if (error) {
            console.error(' Error creating notification:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to create notification"
            });
        }

        console.log(' Notification created successfully:', data);

        return res.json({
            success: true,
            message: "Notification created successfully",
            data
        });

    } catch (error: any) {
        console.error('Error in createNotification:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Récupérer les notifications d'un utilisateur
export async function getNotifications(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { limit = 50, offset = 0, type, unreadOnly = false } = req.query;

        console.log('🔔 Fetching notifications for user:', userId);

        let query = supabase
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

        // Filtrer par type si spécifié
        if (type) {
            query = query.eq('type', type);
        }

        // Filtrer les non lues si demandé
        if (unreadOnly === 'true') {
            query = query.eq('read', false);
        }

        const { data: notifications, error } = await query;

        if (error) {
            console.error('❌ Error fetching notifications:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch notifications"
            });
        }

        console.log(`✅ Found ${notifications?.length || 0} notifications for user ${userId}`);

        return res.json({
            success: true,
            data: notifications || []
        });

    } catch (error: any) {
        console.error('❌ Error in getNotifications:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Marquer une notification comme lue
export async function markNotificationAsRead(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { notificationId } = req.params;

        console.log('🔔 Marking notification as read:', notificationId, 'for user:', userId);

        const { data, error } = await supabase
            .from('notifications')
            .update({ read: true })
            .eq('id', notificationId)
            .eq('user_id', userId)
            .select()
            .single();

        if (error) {
            console.error('❌ Error marking notification as read:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to mark notification as read"
            });
        }

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Notification not found"
            });
        }

        console.log('✅ Notification marked as read:', notificationId);

        return res.json({
            success: true,
            message: "Notification marked as read",
            data
        });

    } catch (error: any) {
        console.error('❌ Error in markNotificationAsRead:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Supprimer une notification
export async function deleteNotification(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const { notificationId } = req.params;

        console.log('🔔 Deleting notification:', notificationId, 'for user:', userId);

        const { error } = await supabase
            .from('notifications')
            .delete()
            .eq('id', notificationId)
            .eq('user_id', userId);

        if (error) {
            console.error('❌ Error deleting notification:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to delete notification"
            });
        }

        console.log('✅ Notification deleted:', notificationId);

        return res.json({
            success: true,
            message: "Notification deleted successfully"
        });

    } catch (error: any) {
        console.error('❌ Error in deleteNotification:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Supprimer toutes les notifications d'un utilisateur
export async function deleteAllNotifications(req: Request, res: Response) {
    try {
        const userId = req.user!.id;

        console.log('🔔 Deleting all notifications for user:', userId);

        const { error } = await supabase
            .from('notifications')
            .delete()
            .eq('user_id', userId);

        if (error) {
            console.error('❌ Error deleting all notifications:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to delete all notifications"
            });
        }

        console.log('✅ All notifications deleted for user:', userId);

        return res.json({
            success: true,
            message: "All notifications deleted successfully"
        });

    } catch (error: any) {
        console.error('❌ Error in deleteAllNotifications:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Obtenir les statistiques des notifications
export async function getNotificationStats(req: Request, res: Response) {
    try {
        const userId = req.user!.id;

        console.log('🔔 Fetching notification stats for user:', userId);

        // Compter les notifications par type
        const { data: typeStats, error: typeError } = await supabase
            .from('notifications')
            .select('type, read')
            .eq('user_id', userId);

        if (typeError) {
            console.error('❌ Error fetching notification stats:', typeError);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch notification stats"
            });
        }

        const stats = {
            total: typeStats?.length || 0,
            unread: typeStats?.filter(n => !n.read).length || 0,
            byType: {
                stop_loss: 0,
                info: 0,
                warning: 0,
                error: 0
            }
        };

        // Compter par type
        typeStats?.forEach(notification => {
            stats.byType[notification.type as keyof typeof stats.byType]++;
        });

        console.log('✅ Notification stats calculated:', stats);

        return res.json({
            success: true,
            data: stats
        });

    } catch (error: any) {
        console.error('❌ Error in getNotificationStats:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Fonction utilitaire pour créer une notification de stop loss
export async function createStopLossNotification(
    userId: string, 
    adId: string, 
    adName: string, 
    reason: string, 
    threshold: number, 
    actualValue: number
) {
    try {
        console.log('🔔 Creating stop loss notification for ad:', adId);

        const { data, error } = await supabase
            .from('notifications')
            .insert({
                user_id: userId,
                type: 'stop_loss',
                title: 'Stop Loss - Seuil atteint',
                message: `La publicité "${adName}" a atteint le seuil de stop loss: ${reason}`,
                ad_id: adId,
                ad_name: adName,
                threshold,
                actual_value: actualValue,
                read: false
            })
            .select()
            .single();

        if (error) {
            console.error('❌ Error creating stop loss notification:', error);
            return null;
        }

        console.log('✅ Stop loss notification created:', data);
        return data;

    } catch (error) {
        console.error('❌ Error in createStopLossNotification:', error);
        return null;
    }
}
