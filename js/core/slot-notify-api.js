/**
 * Edge Function planning-slot-notify — e-mail au propriétaire d’un créneau modifié par un tiers.
 */
import { getAccessToken } from './auth-logic.js';
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

function parseBody(text) {
    if (!text || !text.trim()) return {};
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ ok?: boolean, emailSent?: boolean, skipped?: boolean, error?: string, detail?: string }>}
 */
export async function invokeSlotNotify(payload) {
    const { supabaseUrl, supabaseAnonKey } = getPlanningConfig();
    if (!isBackendAuthConfigured() || !supabaseUrl || !supabaseAnonKey) {
        return { ok: true, emailSent: false, skipped: true };
    }

    let token = await getAccessToken();
    if (!token) {
        return { ok: false, emailSent: false, error: 'Session expirée' };
    }

    const url = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/planning-slot-notify`;

    const doFetch = async (bearer) =>
        fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${bearer}`,
                apikey: supabaseAnonKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

    let res = await doFetch(token);
    if (res.status === 401) {
        const supabase = getSupabaseClient();
        if (supabase) {
            await supabase.auth.refreshSession();
            token = await getAccessToken();
            if (token) res = await doFetch(token);
        }
    }

    const text = await res.text();
    const json = parseBody(text);
    if (!res.ok) {
        return {
            ok: false,
            emailSent: false,
            error:
                (typeof json.error === 'string' && json.error) ||
                text.slice(0, 200) ||
                `HTTP ${res.status}`
        };
    }
    return json;
}
