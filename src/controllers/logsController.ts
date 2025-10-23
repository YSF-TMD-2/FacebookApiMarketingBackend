import { Request, Response } from "../types/express.js";
import { supabase } from "../supabaseClient.js";

// Nettoyer les logs inutiles (actions de récupération de données)
export async function cleanupLogs(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        
        // Actions à supprimer (actions de récupération de données qui polluent les logs)
        const actionsToRemove = [
            'USER_DATA_RETRIEVED',
            'FB_DATA_RETRIEVED', 
            'AD_ACCOUNTS_RETRIEVED',
            'CAMPAIGNS_RETRIEVED',
            'INSIGHTS_RETRIEVED',
            'ADSETS_RETRIEVED',
            'ADS_RETRIEVED',
            'COMPLETE_ANALYTICS_RETRIEVED',
            'ACCOUNT_ANALYTICS_RETRIEVED',
            'BUSINESS_ACCOUNTS_RETRIEVED'
        ];

        console.log(`🧹 Cleaning up logs for user ${userId}...`);

        // Supprimer les logs avec ces actions
        const { data: deletedLogs, error } = await supabase
            .from('logs')
            .delete()
            .eq('user_id', userId)
            .in('action', actionsToRemove)
            .select('id, action, created_at');

        if (error) {
            console.error('❌ Error cleaning up logs:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to clean up logs"
            });
        }

        console.log(`✅ Cleaned up ${deletedLogs?.length || 0} logs`);

        return res.json({
            success: true,
            message: `Successfully cleaned up ${deletedLogs?.length || 0} logs`,
            deletedCount: deletedLogs?.length || 0,
            deletedActions: deletedLogs?.map(log => ({
                action: log.action,
                date: log.created_at
            })) || []
        });

    } catch (error: any) {
        console.error('❌ Error in cleanupLogs:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}

// Récupérer les statistiques des logs
export async function getLogStats(req: Request, res: Response) {
    try {
        const userId = req.user!.id;

        // Compter les logs par action
        const { data: logs, error } = await supabase
            .from('logs')
            .select('action, created_at')
            .eq('user_id', userId);

        if (error) {
            console.error('❌ Error fetching log stats:', error);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch log stats"
            });
        }

        // Analyser les logs
        const stats = {
            totalLogs: logs?.length || 0,
            byAction: {} as Record<string, number>,
            recentLogs: logs?.slice(0, 10).map(log => ({
                action: log.action,
                date: log.created_at
            })) || []
        };

        // Compter par action
        logs?.forEach(log => {
            stats.byAction[log.action] = (stats.byAction[log.action] || 0) + 1;
        });

        return res.json({
            success: true,
            data: stats
        });

    } catch (error: any) {
        console.error('❌ Error in getLogStats:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error"
        });
    }
}
