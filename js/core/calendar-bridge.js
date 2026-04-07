import { getPlanningConfig } from './supabase-client.js';

/**
 * Appelle le pont (Apps Script ou Edge Function) qui synchronise avec Google Agenda.
 * @param {string | null} accessToken — JWT Supabase (Authorization: Bearer)
 * @param {Record<string, unknown>} body — ex. { action: 'upsert', events: [...] }
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, data?: unknown }>}
 */
export async function invokeCalendarBridge(accessToken, body) {
    const { calendarBridgeUrl } = getPlanningConfig();
    if (!calendarBridgeUrl) {
        return { ok: true, skipped: true };
    }

    try {
        const res = await fetch(calendarBridgeUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
            },
            body: JSON.stringify(body)
        });

        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = text;
        }

        if (!res.ok) {
            return {
                ok: false,
                error: typeof data === 'string' ? data : data?.error || res.statusText || `HTTP ${res.status}`
            };
        }

        return { ok: true, data };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}
