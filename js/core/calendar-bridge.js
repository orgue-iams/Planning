import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/**
 * Appelle le pont (Apps Script ou Edge Function) qui synchronise avec Google Agenda.
 * @param {string | null} accessToken — JWT Supabase (Authorization: Bearer)
 * @param {Record<string, unknown>} body — ex. { action: 'upsert', events: [...] }
 * @param {{ signal?: AbortSignal } | undefined} options — pour annuler une requête obsolète (changement de semaine)
 * @returns {Promise<{ ok: boolean, skipped?: boolean, aborted?: boolean, error?: string, data?: unknown }>}
 */
export async function invokeCalendarBridge(accessToken, body, options) {
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

    const signal = options?.signal;

    try {
        const doFetch = async (bearer) =>
            fetch(calendarBridgeUrl, {
                method: 'POST',
                signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseAnonKey ? { apikey: supabaseAnonKey } : {}),
                    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
                },
                body: JSON.stringify(body)
            });

        let token = accessToken;
        let res = await doFetch(token);
        /* Passerelle ou JWT expiré : rafraîchir et réessayer (403 aussi selon les proxies). */
        if ((res.status === 401 || res.status === 403) && isBackendAuthConfigured()) {
            const supabase = getSupabaseClient();
            if (supabase) {
                const { data: refData } = await supabase.auth.refreshSession();
                let nextTok = refData?.session?.access_token ?? null;
                if (!nextTok) {
                    const { data: { session } } = await supabase.auth.getSession();
                    nextTok = session?.access_token ?? null;
                }
                if (nextTok) {
                    token = nextTok;
                    res = await doFetch(token);
                }
            }
        }

        const { data } = await parseResponse(res);

        if (!res.ok) {
            const msg =
                typeof data === 'string'
                    ? data
                    : data?.error || data?.message || data?.msg || res.statusText || `HTTP ${res.status}`;
            return {
                ok: false,
                error: typeof msg === 'string' ? msg : `HTTP ${res.status}`
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
        if (e instanceof Error && e.name === 'AbortError') {
            return { ok: false, aborted: true };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}

/**
 * @param {string | null} accessToken
 * @param {{ timeMin: string, timeMax: string, calendarId?: string }} p
 */
export async function bridgeListEvents(accessToken, p, options = {}) {
    return invokeCalendarBridge(
        accessToken,
        {
            action: 'list',
            timeMin: p.timeMin,
            timeMax: p.timeMax,
            ...(p.calendarId ? { calendarId: p.calendarId } : {})
        },
        options
    );
}

/**
 * @param {string | null} accessToken
 * @param {string} googleEventId
 * @param {string} [calendarId]
 */
export async function bridgeDeleteEvent(accessToken, googleEventId, calendarId, options) {
    return invokeCalendarBridge(
        accessToken,
        {
            action: 'delete',
            googleEventId,
            ...(calendarId ? { calendarId } : {})
        },
        options
    );
}

/**
 * @param {string | null} accessToken
 * @param {Record<string, unknown>[]} events
 * @param {string} [defaultCalendarId]
 */
export async function bridgeUpsertEvents(accessToken, events, defaultCalendarId, options = {}) {
    return invokeCalendarBridge(
        accessToken,
        {
            action: 'upsert',
            events,
            ...(defaultCalendarId ? { calendarId: defaultCalendarId } : {})
        },
        options
    );
}
