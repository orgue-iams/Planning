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

import { SignJWT, importPKCS8 } from 'https://deno.land/x/jose@v5.6.0/index.ts';
import { fetchAuthUser } from '../_shared/auth_gotrue.ts';
import { normalizeGoogleCalendarId } from '../_shared/normalize_google_calendar_id.ts';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';

const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-version'
};

/** E-mail issu du JWT (claim `email`) si absent de la réponse GoTrue /auth/v1/user. */
function emailFromSupabaseJwt(accessToken: string): string {
    try {
        const parts = accessToken.split('.');
        if (parts.length < 2) return '';
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const payload = JSON.parse(atob(b64)) as { email?: string };
        return typeof payload.email === 'string' ? payload.email.trim() : '';
    } catch {
        return '';
    }
}

type ServiceAccountCreds = { client_email: string; private_key: string };

type BridgeBody = {
    action?: string;
    timeMin?: string;
    timeMax?: string;
    /** Calendrier Google (ID brut ou e-mail). Défaut : GOOGLE_CALENDAR_ID. */
    calendarId?: string;
    events?: Array<{
        title?: string;
        start?: string;
        end?: string;
        type?: string;
        owner?: string;
        googleEventId?: string;
        calendarId?: string;
        /** E-mails élèves séparés par virgule (description + private). */
        inscrits?: string;
        templateLineId?: string;
        /** ID de l’événement miroir sur l’agenda perso (pool) — stocké en private sur l’événement principal. */
        poolGoogleEventId?: string;
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
    let id = (Deno.env.get('GOOGLE_CALENDAR_ID') ?? '').trim();
    if (!id) throw new Error('GOOGLE_CALENDAR_ID manquant');
    /* Éviter un double encodage (%40…) qui casse l’URL `/calendars/{id}/events` → 404 Not Found. */
    try {
        if (id.includes('%')) {
            const once = decodeURIComponent(id);
            if (once && !once.includes('%')) id = once;
        }
    } catch {
        /* garder id tel quel */
    }
    return id;
}

function resolveCalendarId(override?: string): string {
    const o = override?.trim();
    if (o) {
        let id = o;
        try {
            if (id.includes('%')) {
                const once = decodeURIComponent(id);
                if (once && !once.includes('%')) id = once;
            }
        } catch {
            /* */
        }
        return id;
    }
    return calendarId();
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

/**
 * Couleur d’événement Google Calendar (palette fixe 1–11).
 * Aligné sur les teintes saturées de la grille Planning (events.css --slot-bg-strong) :
 * - Fermeture : orange (#ff790a → proche Tangerine)
 * - Cours : jaune (#f6e36a → Banana)
 * - Travail (reservation) : toujours bleu « Autres » (#68a1e5 → Peacock), sans distinguer propriétaire
 * @see https://developers.google.com/calendar/api/v3/reference/events#resource
 */
function googleColorIdForPlanningType(type: string): string {
    const t = String(type || '').trim().toLowerCase();
    if (t === 'fermeture') return '6'; /* Tangerine — orange */
    if (t === 'cours' || t === 'maintenance') return '5'; /* Banana — jaune */
    /* reservation et défaut = Travail → bleu (même teinte côté app que « travail other / Autres ») */
    return '7'; /* Peacock — bleu */
}

function parseInscritsCsv(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    return raw
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function parseDescription(desc: string | undefined): { type: string; owner: string; inscrits: string[] } {
    let type = 'reservation';
    let owner = '';
    const inscrits: string[] = [];
    if (!desc) return { type, owner, inscrits };
    const typeM = desc.match(/type=([^\s]+)/);
    const ownerM = desc.match(/owner=([^\s]+)/);
    const inscM = desc.match(/inscrits=([^\n]+)/i);
    if (typeM) type = typeM[1] || type;
    if (ownerM) owner = String(ownerM[1] || '').trim();
    if (inscM) {
        for (const x of parseInscritsCsv(inscM[1])) inscrits.push(x);
    }
    return { type, owner, inscrits };
}

function fcEventFromGoogle(e: GCalEvent) {
    const priv = e.extendedProperties?.private;
    let type = priv?.planningType?.trim() || '';
    let owner = priv?.planningOwner?.trim() || '';
    let inscrits = parseInscritsCsv(priv?.planningInscrits);
    const templateLineId = String(priv?.planningTemplateLineId ?? '').trim();
    const poolGoogleEventId = String(priv?.planningPoolEventId ?? '').trim();
    const parsed = parseDescription(e.description);
    if (!type) type = parsed.type;
    if (!owner) owner = parsed.owner;
    if (inscrits.length === 0) inscrits = parsed.inscrits;
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
            type,
            inscrits,
            ...(templateLineId ? { templateLineId } : {}),
            ...(poolGoogleEventId ? { poolGoogleEventId } : {})
        }
    };
}

type EventPayloadInput = {
    title: string;
    start: string;
    end: string;
    type: string;
    owner: string;
    inscrits?: string;
    templateLineId?: string;
    poolGoogleEventId?: string;
};

/** Sur l’événement « miroir » du calendrier pool, ne pas recopier planningPoolEventId (réservé au principal). */
function googleEventResource(
    ev: EventPayloadInput,
    opts?: { forPoolCalendarWrite?: boolean }
): Record<string, unknown> {
    const tz = timeZone();
    const colorId = googleColorIdForPlanningType(ev.type);
    const insc = (ev.inscrits ?? '').trim();
    const descParts = [`type=${ev.type || ''}`, `owner=${ev.owner || ''}`];
    if (insc) descParts.push(`inscrits=${insc}`);
    const priv: Record<string, string> = {
        planningType: String(ev.type || 'reservation'),
        planningOwner: String(ev.owner || '')
    };
    if (insc) priv.planningInscrits = insc.replace(/\s+/g, '');
    const tid = (ev.templateLineId ?? '').trim();
    if (tid) priv.planningTemplateLineId = tid;
    const poolGid = (ev.poolGoogleEventId ?? '').trim();
    if (poolGid && !opts?.forPoolCalendarWrite) priv.planningPoolEventId = poolGid;
    return {
        summary: ev.title,
        description: descParts.join(' '),
        start: { dateTime: ev.start, timeZone: tz },
        end: { dateTime: ev.end, timeZone: tz },
        colorId,
        extendedProperties: { private: priv }
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

async function fetchPlanningPoolCalendarId(
    projectUrl: string,
    anonKey: string,
    jwt: string,
    userId: string
): Promise<string> {
    const base = projectUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/rest/v1/rpc/planning_pool_calendar_id`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${jwt}`
        },
        body: JSON.stringify({ p_user_id: userId })
    });
    if (!res.ok) return '';
    const t = await res.text();
    if (!t || t === 'null') return '';
    try {
        const j = JSON.parse(t) as unknown;
        if (typeof j === 'string') return j.trim();
        return '';
    } catch {
        return String(t).replace(/^"|"$/g, '').trim();
    }
}

/**
 * Après écriture sur le calendrier principal : copie sur l’agenda Google « pool » du même utilisateur
 * (JWT = propriétaire du créneau). Évite de dépendre du client (id session, double requête).
 */
async function mirrorOwnerPersonalCalendarIfNeeded(
    accessToken: string,
    user: { id: string; email?: string },
    jwt: string,
    supabaseUrl: string,
    supabaseAnonKey: string,
    ev: NonNullable<BridgeBody['events']>[0],
    body: BridgeBody,
    mainCalendarEventId: string
): Promise<void> {
    if (!supabaseUrl || !supabaseAnonKey || !user.id) {
        console.warn('[calendar-bridge] mirror skip: supabase url/anon key ou user.id manquant');
        return;
    }
    const me = String(user.email || '').trim().toLowerCase();
    if (!me) {
        console.warn('[calendar-bridge] mirror skip: e-mail JWT absent (impossible de résoudre le pool)');
        return;
    }

    const mainCal = calendarId();
    const targetCal = resolveCalendarId(ev.calendarId ?? body.calendarId);
    if (targetCal !== mainCal) return;

    const ownerRaw = String(ev.owner || '').trim().toLowerCase();
    /* owner vide = créneau imputé au compte connecté (évite un miroir bloqué si le client n’envoie pas owner). */
    if (ownerRaw && ownerRaw !== me) {
        console.warn(
            '[calendar-bridge] mirror skip: owner du créneau ≠ compte connecté (miroir pool uniquement si l’élève crée pour lui-même).',
            { ownerPayload: ownerRaw, jwtEmail: me }
        );
        return;
    }

    const st = String(ev.type || 'reservation').trim().toLowerCase();
    if (st === 'fermeture') return;

    const poolCalRaw = await fetchPlanningPoolCalendarId(supabaseUrl, supabaseAnonKey, jwt, user.id);
    const poolCal = normalizeGoogleCalendarId(poolCalRaw);
    if (!poolCal || resolveCalendarId(poolCal) === mainCal) {
        console.warn('[calendar-bridge] mirror skip: pas de calendrier pool pour ce user ou id = principal', {
            poolRawLen: poolCalRaw.length,
            poolCal: poolCal ? poolCal.slice(0, 48) + '…' : ''
        });
        return;
    }

    const title = String(ev.title || '').trim();
    const start = ev.start;
    const end = ev.end;
    if (!title || !start || !end) return;

    const baseFields: EventPayloadInput = {
        title,
        start,
        end,
        type: String(ev.type || 'reservation'),
        owner: String(ev.owner || ''),
        inscrits: ev.inscrits,
        templateLineId: ev.templateLineId
    };

    const poolPayload = googleEventResource(
        { ...baseFields, poolGoogleEventId: undefined },
        { forPoolCalendarWrite: true }
    );
    const encPool = encodeURIComponent(poolCal);
    let poolOutId = String(ev.poolGoogleEventId ?? '').trim();

    if (poolOutId) {
        const encEid = encodeURIComponent(poolOutId);
        const patchP = await gcalFetch(
            accessToken,
            `/calendars/${encPool}/events/${encEid}`,
            {
                method: 'PATCH',
                body: JSON.stringify(poolPayload)
            }
        );
        if (!patchP.ok && patchP.status !== 404) {
            console.error('[calendar-bridge] PATCH miroir pool:', patchP.status, await patchP.text());
            return;
        }
        if (patchP.status === 404) poolOutId = '';
    }

    if (!poolOutId) {
        const insP = await gcalFetch(accessToken, `/calendars/${encPool}/events`, {
            method: 'POST',
            body: JSON.stringify(poolPayload)
        });
        const created = (await insP.json()) as GCalEvent & { error?: { message?: string } };
        if (!insP.ok || !created.id) {
            const msg = created.error?.message || `HTTP ${insP.status}`;
            const hint404 =
                insP.status === 404
                    ? ' — Partagez ce calendrier secondaire avec le compte Google utilisé par calendar-bridge (même procédure que pour l’agenda principal : « Modifier les événements »). Si l’ID en base était une URL embed complète, utilisez uniquement xxx@group.calendar.google.com (normalisation côté serveur activée).'
                    : '';
            const hintWriter =
                /writer access|need to have writer|403/i.test(msg) && !hint404
                    ? ' — Dans Google Agenda : ce calendrier secondaire → Partager avec l’e-mail du compte OAuth du bridge (ex. orgue.iams@gmail.com) avec « Modifier les événements », pas seulement lecture ou « public ».'
                    : '';
            console.error('[calendar-bridge] POST miroir pool:', msg + hint404 + hintWriter);
            return;
        }
        poolOutId = created.id || '';
    }

    if (!poolOutId) return;

    const linkPayload = googleEventResource({
        ...baseFields,
        poolGoogleEventId: poolOutId
    });
    const encMain = encodeURIComponent(mainCal);
    const linkPatch = await gcalFetch(
        accessToken,
        `/calendars/${encMain}/events/${encodeURIComponent(mainCalendarEventId)}`,
        {
            method: 'PATCH',
            body: JSON.stringify(linkPayload)
        }
    );
    if (!linkPatch.ok) {
        console.error('[calendar-bridge] PATCH lien principal→pool:', linkPatch.status, await linkPatch.text());
    }
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

        const { user, error: authErr } = await fetchAuthUser(supabaseUrl, supabaseAnonKey, jwt);
        if (authErr || !user) {
            return jsonResponse({ error: authErr || 'Unauthorized' }, 401);
        }

        const resolvedEmail = (user.email?.trim() || emailFromSupabaseJwt(jwt)).trim();
        const calendarUser = { id: user.id, email: resolvedEmail || user.email?.trim() || '' };

        let body: BridgeBody;
        try {
            body = (await req.json()) as BridgeBody;
        } catch {
            return jsonResponse({ ok: false, error: 'JSON invalide' }, 400);
        }

        const accessToken = await getGoogleAccessToken();

        const action = String(body.action || '');

        if (action === 'list') {
            const timeMin = body.timeMin;
            const timeMax = body.timeMax;
            if (!timeMin || !timeMax) {
                return jsonResponse({ ok: false, error: 'timeMin et timeMax requis (ISO 8601)' }, 400);
            }

            const calId = encodeURIComponent(resolveCalendarId(body.calendarId));

            const params = new URLSearchParams({
                timeMin,
                timeMax,
                singleEvents: 'true',
                orderBy: 'startTime',
                maxResults: '2500'
            });
            const res = await gcalFetch(accessToken, `/calendars/${calId}/events?${params}`);
            const data = (await res.json()) as {
                items?: GCalEvent[];
                error?: { message?: string; errors?: Array<{ message?: string; reason?: string }> };
            };
            if (!res.ok) {
                let gErr = typeof data.error?.message === 'string' ? data.error.message.trim() : '';
                if (!gErr && Array.isArray(data.error?.errors) && data.error.errors.length > 0) {
                    const e0 = data.error.errors[0];
                    gErr =
                        (typeof e0?.message === 'string' && e0.message.trim()) ||
                        (typeof e0?.reason === 'string' && e0.reason.trim()) ||
                        '';
                }
                return jsonResponse(
                    {
                        ok: false,
                        error: gErr || `Calendar list HTTP ${res.status}`
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
            const calIdDel = encodeURIComponent(resolveCalendarId(body.calendarId));
            const encEid = encodeURIComponent(eid);
            const res = await gcalFetch(accessToken, `/calendars/${calIdDel}/events/${encEid}`, {
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
                    const calIdUpsert = encodeURIComponent(
                        resolveCalendarId(ev.calendarId ?? body.calendarId)
                    );
                    const payload = googleEventResource({
                        title,
                        start,
                        end,
                        type: String(ev.type || 'reservation'),
                        owner: String(ev.owner || ''),
                        inscrits: ev.inscrits,
                        templateLineId: ev.templateLineId,
                        poolGoogleEventId: ev.poolGoogleEventId
                    });
                    const gid = ev.googleEventId?.trim();

                    let mainOutId = '';

                    if (gid) {
                        const encEid = encodeURIComponent(gid);
                        const patch = await gcalFetch(
                            accessToken,
                            `/calendars/${calIdUpsert}/events/${encEid}`,
                            {
                                method: 'PATCH',
                                body: JSON.stringify(payload)
                            }
                        );
                        if (patch.ok) {
                            mainOutId = gid;
                        } else if (patch.status !== 404) {
                            const t = await patch.text();
                            throw new Error(t.slice(0, 200) || `PATCH ${patch.status}`);
                        }
                    }

                    if (!mainOutId) {
                        const ins = await gcalFetch(accessToken, `/calendars/${calIdUpsert}/events`, {
                            method: 'POST',
                            body: JSON.stringify(payload)
                        });
                        const created = (await ins.json()) as GCalEvent & { error?: { message?: string } };
                        if (!ins.ok || !created.id) {
                            throw new Error(created.error?.message || `POST événement HTTP ${ins.status}`);
                        }
                        mainOutId = created.id || '';
                    }

                    await mirrorOwnerPersonalCalendarIfNeeded(
                        accessToken,
                        calendarUser,
                        jwt,
                        supabaseUrl,
                        supabaseAnonKey,
                        ev,
                        body,
                        mainOutId
                    );

                    return { googleEventId: mainOutId, start, end };
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
