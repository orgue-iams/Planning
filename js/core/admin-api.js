import { getAccessToken } from './auth-logic.js';
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

function parseFunctionsBody(text) {
    if (!text || !text.trim()) return {};
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

/** Si le serveur renvoie une chaîne JSON GoTrue dans `error`, n’afficher que `message`. */
function unwrapNestedJsonMessage(s) {
    if (!s || typeof s !== 'string') return s;
    const t = s.trim();
    if (!t.startsWith('{') || !t.includes('"message"')) return t;
    try {
        const o = JSON.parse(t);
        if (o && typeof o.message === 'string' && o.message.trim()) return o.message.trim();
    } catch {
        /* */
    }
    return t;
}

function errorMessageFromResponse(res, text, json) {
    let err = typeof json.error === 'string' ? json.error.trim() : '';
    err = unwrapNestedJsonMessage(err) || err;
    const msg = typeof json.message === 'string' ? json.message.trim() : '';
    if (err || msg) return err || msg;
    const trimmed = text.trim();
    if (trimmed && !trimmed.startsWith('<') && trimmed.length < 500) return trimmed;
    const st = typeof res.statusText === 'string' ? res.statusText.trim() : '';
    if (st) return `${st} (HTTP ${res.status})`;
    if (res.status === 404) {
        return `Fonction introuvable (HTTP 404). Déployez l’Edge Function « planning-admin » sur le projet Supabase.`;
    }
    return `Erreur HTTP ${res.status}`;
}

/**
 * Appelle l’Edge Function planning-admin (réservée aux comptes profiles.role = admin).
 */
export async function planningAdminInvoke(action, payload = {}) {
    const { supabaseUrl, supabaseAnonKey } = getPlanningConfig();
    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase non configuré');
    }
    let token = await getAccessToken();
    if (!token) throw new Error('Session expirée');

    const doFetch = async (bearer) =>
        fetch(`${supabaseUrl}/functions/v1/planning-admin`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${bearer}`,
                apikey: supabaseAnonKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action, ...payload })
        });

    let res = await doFetch(token);
    if (res.status === 401 && isBackendAuthConfigured()) {
        const supabase = getSupabaseClient();
        if (supabase) {
            await supabase.auth.refreshSession();
            token = await getAccessToken();
            if (token) res = await doFetch(token);
        }
    }

    const text = await res.text();
    const json = parseFunctionsBody(text);
    if (!res.ok) {
        throw new Error(errorMessageFromResponse(res, text, json));
    }
    return json;
}
