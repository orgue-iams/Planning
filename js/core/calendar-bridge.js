import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/**
 * Appelle le pont (Apps Script ou Edge Function) qui synchronise avec Google Agenda.
 * @param {string | null} accessToken — JWT Supabase (Authorization: Bearer)
 * @param {Record<string, unknown>} body — ex. { action: 'upsert', events: [...] }
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, data?: unknown }>}
 */
export async function invokeCalendarBridge(accessToken, body) {
    const { calendarBridgeUrl, supabaseAnonKey } = getPlanningConfig();
    if (!calendarBridgeUrl) {
        return { ok: true, skipped: true };
    }

    const parseResponse = async (res) => {
        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = text;
        }
        return { data };
    };

    try {
        const doFetch = async (bearer) =>
            fetch(calendarBridgeUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseAnonKey ? { apikey: supabaseAnonKey } : {}),
                    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
                },
                body: JSON.stringify(body)
            });

        let token = accessToken;
        let res = await doFetch(token);
        if (res.status === 401 && isBackendAuthConfigured()) {
            const supabase = getSupabaseClient();
            if (supabase) {
                await supabase.auth.refreshSession();
                const { data: { session } } = await supabase.auth.getSession();
                const refreshed = session?.access_token ?? null;
                if (refreshed && refreshed !== token) {
                    token = refreshed;
                    res = await doFetch(token);
                }
            }
        }

        const { data } = await parseResponse(res);

        if (!res.ok) {
            return {
                ok: false,
                error: typeof data === 'string' ? data : data?.error || res.statusText || `HTTP ${res.status}`
            };
        }

        if (typeof data === 'object' && data !== null && data.ok === false) {
            return {
                ok: false,
                error: typeof data.error === 'string' ? data.error : 'Erreur pont agenda',
                data
            };
        }

        return { ok: true, data };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}
