/**
 * Edge Function : JWT Supabase → Google Calendar API v3 (direct, sans Apps Script).
 *
 * Auth Google (au choix, par ordre de priorité) :
 *   1) Compte de service : GOOGLE_SERVICE_ACCOUNT_JSON = JSON téléchargé GCP (clé privée incluse).
 *      Le calendrier orgue.iams@google.com doit être partagé avec l’e-mail du compte de service
 *      (lecture/écriture des événements), sauf si vous utilisez la délégation domain-wide (voir plus bas).
 *   2) Refresh token OAuth : GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 *      (compte orgue.iams@google.com, flux installé une fois hors Edge).
 *
 * Obligatoire :
 *   GOOGLE_CALENDAR_ID = ex. orgue.iams@google.com (ID du calendrier dans Google Calendar)
 *
 * Optionnel :
 *   GOOGLE_CALENDAR_TIMEZONE = Europe/Paris (défaut Europe/Paris)
 *   GOOGLE_CALENDAR_IMPERSONATE = e-mail utilisateur si délégation domain-wide (Workspace) ;
 *      dans ce cas le SA n’a pas besoin du partage explicite du calendrier si les scopes sont délégués.
 *
 * Déploiement : supabase functions deploy calendar-bridge
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { SignJWT, importPKCS8 } from 'https://deno.land/x/jose@v5.6.0/index.ts';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';

const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-version'
};

type ServiceAccountCreds = { client_email: string; private_key: string };

type BridgeBody = {
    action?: string;
    timeMin?: string;
    timeMax?: string;
    events?: Array<{
        title?: string;
        start?: string;
        end?: string;
        type?: string;
        owner?: string;
        googleEventId?: string;
    }>;
    googleEventId?: string;
};

function jsonResponse(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

function parseServiceAccountJson(raw: string): ServiceAccountCreds {
    const creds = JSON.parse(raw) as ServiceAccountCreds;
    if (!creds.client_email || !creds.private_key) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON invalide (client_email / private_key)');
    }
    return {
        client_email: creds.client_email,
        private_key: creds.private_key.replace(/\\n/g, '\n')
    };
}

async function accessTokenFromServiceAccount(creds: ServiceAccountCreds, impersonate?: string): Promise<string> {
    const key = await importPKCS8(creds.private_key, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const jwtBuilder = new SignJWT({ scope: CAL_SCOPE })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(creds.client_email)
        .setAudience(TOKEN_URL)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600);
    if (impersonate?.trim()) {
        jwtBuilder.setSubject(impersonate.trim());
    }
    const assertion = await jwtBuilder.sign(key);

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || `Token SA : HTTP ${res.status}`);
    }
    return data.access_token;
}

async function accessTokenFromRefreshToken(): Promise<string> {
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') ?? '';
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '';
    const refreshToken = Deno.env.get('GOOGLE_OAUTH_REFRESH_TOKEN') ?? '';
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('OAuth incomplet (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)');
    }
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || `Token OAuth : HTTP ${res.status}`);
    }
    return data.access_token;
}

async function getGoogleAccessToken(): Promise<string> {
    const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    const impersonate = Deno.env.get('GOOGLE_CALENDAR_IMPERSONATE') ?? '';
    if (saJson?.trim()) {
        const creds = parseServiceAccountJson(saJson.trim());
        return await accessTokenFromServiceAccount(
            creds,
            impersonate.trim() ? impersonate : undefined
        );
    }
    return await accessTokenFromRefreshToken();
}

function calendarId(): string {
    const id = (Deno.env.get('GOOGLE_CALENDAR_ID') ?? '').trim();
    if (!id) throw new Error('GOOGLE_CALENDAR_ID manquant');
    return id;
}

function timeZone(): string {
    return (Deno.env.get('GOOGLE_CALENDAR_TIMEZONE') ?? 'Europe/Paris').trim() || 'Europe/Paris';
}

type GCalEvent = {
    id?: string;
    summary?: string;
    description?: string;
    start?: { dateTime?: string; date?: string; timeZone?: string };
    end?: { dateTime?: string; date?: string; timeZone?: string };
    extendedProperties?: { private?: Record<string, string> };
};

function parseDescription(desc: string | undefined): { type: string; owner: string } {
    let type = 'reservation';
    let owner = '';
    if (!desc) return { type, owner };
    const typeM = desc.match(/type=([^\s]+)/);
    const ownerM = desc.match(/owner=(.+)$/);
    if (typeM) type = typeM[1] || type;
    if (ownerM) owner = String(ownerM[1] || '').trim();
    return { type, owner };
}

function fcEventFromGoogle(e: GCalEvent) {
    const priv = e.extendedProperties?.private;
    let type = priv?.planningType?.trim() || '';
    let owner = priv?.planningOwner?.trim() || '';
    if (!type || !owner) {
        const parsed = parseDescription(e.description);
        if (!type) type = parsed.type;
        if (!owner) owner = parsed.owner;
    }
    if (!type) type = 'reservation';
    const gid = e.id ?? '';
    const start = e.start?.dateTime ?? e.start?.date;
    const end = e.end?.dateTime ?? e.end?.date;
    if (!start || !end) return null;
    return {
        id: gid,
        title: (e.summary || 'Occupation').trim() || 'Occupation',
        start,
        end,
        extendedProps: {
            googleEventId: gid,
            owner,
            ownerDisplayName: owner ? owner.split('@')[0] : '',
            ownerRole: '',
            type
        }
    };
}

function googleEventResource(ev: {
    title: string;
    start: string;
    end: string;
    type: string;
    owner: string;
}): Record<string, unknown> {
    const tz = timeZone();
    return {
        summary: ev.title,
        description: `type=${ev.type || ''} owner=${ev.owner || ''}`,
        start: { dateTime: ev.start, timeZone: tz },
        end: { dateTime: ev.end, timeZone: tz },
        extendedProperties: {
            private: {
                planningType: String(ev.type || 'reservation'),
                planningOwner: String(ev.owner || '')
            }
        }
    };
}

async function gcalFetch(accessToken: string, pathWithQuery: string, init?: RequestInit) {
    const url = `${API_BASE}${pathWithQuery}`;
    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...init?.headers
        }
    });
    return res;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return jsonResponse({ error: 'Missing Authorization' }, 401);
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (!jwt) {
            return jsonResponse({ error: 'Missing Authorization' }, 401);
        }

        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            auth: { autoRefreshToken: false, persistSession: false },
            global: { headers: { Authorization: authHeader } }
        });

        const {
            data: { user },
            error: userErr
        } = await supabase.auth.getUser(jwt);
        if (userErr || !user) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
        }

        let body: BridgeBody;
        try {
            body = (await req.json()) as BridgeBody;
        } catch {
            return jsonResponse({ ok: false, error: 'JSON invalide' }, 400);
        }

        const accessToken = await getGoogleAccessToken();
        const calId = encodeURIComponent(calendarId());

        const action = String(body.action || '');

        if (action === 'list') {
            const timeMin = body.timeMin;
            const timeMax = body.timeMax;
            if (!timeMin || !timeMax) {
                return jsonResponse({ ok: false, error: 'timeMin et timeMax requis (ISO 8601)' }, 400);
            }

            const params = new URLSearchParams({
                timeMin,
                timeMax,
                singleEvents: 'true',
                orderBy: 'startTime',
                maxResults: '2500'
            });
            const res = await gcalFetch(accessToken, `/calendars/${calId}/events?${params}`);
            const data = (await res.json()) as { items?: GCalEvent[]; error?: { message?: string } };
            if (!res.ok) {
                return jsonResponse(
                    {
                        ok: false,
                        error: data.error?.message || `Calendar list HTTP ${res.status}`
                    },
                    200
                );
            }

            const items = data.items ?? [];
            const events = [];
            for (const e of items) {
                const row = fcEventFromGoogle(e);
                if (row) events.push(row);
            }
            return jsonResponse({ ok: true, events });
        }

        if (action === 'delete') {
            const eid = body.googleEventId?.trim();
            if (!eid) {
                return jsonResponse({ ok: false, error: 'googleEventId requis' }, 400);
            }
            const encEid = encodeURIComponent(eid);
            const res = await gcalFetch(accessToken, `/calendars/${calId}/events/${encEid}`, {
                method: 'DELETE'
            });
            if (res.status === 204 || res.ok) {
                return jsonResponse({ ok: true });
            }
            let msg = `HTTP ${res.status}`;
            try {
                const err = (await res.json()) as { error?: { message?: string } };
                if (err.error?.message) msg = err.error.message;
            } catch {
                /* */
            }
            return jsonResponse({ ok: false, error: msg }, 200);
        }

        if (action === 'upsert' && body.events && body.events.length > 0) {
            const results = await Promise.all(
                body.events.map(async (ev) => {
                    const title = String(ev.title || '').trim();
                    const start = ev.start;
                    const end = ev.end;
                    if (!title || !start || !end) {
                        throw new Error('Champs title, start et end requis pour chaque événement');
                    }
                    const payload = googleEventResource({
                        title,
                        start,
                        end,
                        type: String(ev.type || 'reservation'),
                        owner: String(ev.owner || '')
                    });
                    const gid = ev.googleEventId?.trim();

                    if (gid) {
                        const encEid = encodeURIComponent(gid);
                        const patch = await gcalFetch(accessToken, `/calendars/${calId}/events/${encEid}`, {
                            method: 'PATCH',
                            body: JSON.stringify(payload)
                        });
                        if (patch.ok) {
                            return { googleEventId: gid, start, end };
                        }
                        if (patch.status !== 404) {
                            const t = await patch.text();
                            throw new Error(t.slice(0, 200) || `PATCH ${patch.status}`);
                        }
                    }

                    const ins = await gcalFetch(accessToken, `/calendars/${calId}/events`, {
                        method: 'POST',
                        body: JSON.stringify(payload)
                    });
                    const created = (await ins.json()) as GCalEvent & { error?: { message?: string } };
                    if (!ins.ok || !created.id) {
                        throw new Error(created.error?.message || `POST événement HTTP ${ins.status}`);
                    }
                    return { googleEventId: created.id, start, end };
                })
            );

            return jsonResponse({ ok: true, results });
        }

        return jsonResponse({ ok: false, error: 'Action ou payload inconnu' }, 400);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return jsonResponse({ ok: false, error: msg }, 500);
    }
});
