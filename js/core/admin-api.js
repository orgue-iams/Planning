import { getAccessToken } from './auth-logic.js';
import { getPlanningConfig } from './supabase-client.js';

/**
 * Appelle l’Edge Function planning-admin (réservée aux comptes profiles.role = admin).
 */
export async function planningAdminInvoke(action, payload = {}) {
    const { supabaseUrl, supabaseAnonKey } = getPlanningConfig();
    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase non configuré');
    }
    const token = await getAccessToken();
    if (!token) throw new Error('Session expirée');

    const res = await fetch(`${supabaseUrl}/functions/v1/planning-admin`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            apikey: supabaseAnonKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action, ...payload })
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(json.error || res.statusText || 'Erreur serveur');
    }
    return json;
}
