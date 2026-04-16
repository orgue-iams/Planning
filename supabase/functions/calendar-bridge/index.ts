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
        /** Ligne `planning_event.id` : après upsert Google, enregistrement des miroirs (service_role). */
        planningEventId?: string;
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

/** Comparaison tolérante (casse) pour ne pas bloquer le miroir pool si l’ID principal diffère seulement par la casse. */
function sameGoogleCalendarId(a: string, b: string): boolean {
    const x = resolveCalendarId(a).trim().toLowerCase();
    const y = resolveCalendarId(b).trim().toLowerCase();
    return x === y && x.length > 0;
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
    if (t === 'concert') return '11'; /* Dark purple — Concert */
    if (t === 'autre') return '1'; /* Lavender — Autre */
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
    /** UUID `planning_event.id` — étiquette Google pour retrouver l’événement si les ids connus sont invalides (évite POST = doublon). */
    planningEventId?: string;
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
    const pev = (ev.planningEventId ?? '').trim();
    if (pev) priv.planningEventId = pev;
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

function dedupeGoogleEventIds(candidates: Array<string | undefined | null>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
        const t = String(c ?? '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

/**
 * Liste les ids d’événements portant `privateExtendedProperty` planningEventId=<uuid> (toutes pages courtes).
 */
async function listEventIdsByPlanningPrivateProperty(
    accessToken: string,
    calendarIdRaw: string,
    planningUuid: string
): Promise<string[]> {
    const u = planningUuid.trim();
    if (!u) return [];
    const encCal = encodeURIComponent(resolveCalendarId(calendarIdRaw));
    const collected: string[] = [];
    let pageToken = '';
    for (let page = 0; page < 12; page++) {
        const params = new URLSearchParams({
            privateExtendedProperty: `planningEventId=${u}`,
            singleEvents: 'true',
            maxResults: '250'
        });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await gcalFetch(accessToken, `/calendars/${encCal}/events?${params}`);
        const raw = await res.text();
        if (!res.ok) {
            console.warn('[calendar-bridge] list by planningEventId', res.status, raw.slice(0, 240));
            break;
        }
        let data: { items?: Array<{ id?: string }>; nextPageToken?: string };
        try {
            data = JSON.parse(raw) as { items?: Array<{ id?: string }>; nextPageToken?: string };
        } catch {
            break;
        }
        for (const it of data.items ?? []) {
            const id = String(it?.id ?? '').trim();
            if (id) collected.push(id);
        }
        pageToken = String(data.nextPageToken ?? '').trim();
        if (!pageToken) break;
    }
    return dedupeGoogleEventIds(collected);
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

async function fetchPlanningUserIdForEmail(
    projectUrl: string,
    anonKey: string,
    jwt: string,
    email: string
): Promise<string> {
    const base = projectUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/rest/v1/rpc/planning_user_id_for_email`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${jwt}`
        },
        body: JSON.stringify({ p_email: email.trim() })
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

async function fetchPlanningPoolCalendarIdForOwnerEmail(
    projectUrl: string,
    anonKey: string,
    jwt: string,
    ownerEmail: string
): Promise<string> {
    const base = projectUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/rest/v1/rpc/planning_pool_calendar_id_for_owner_email`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${jwt}`
        },
        body: JSON.stringify({ p_owner_email: ownerEmail.trim() })
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
 * Crée ou met à jour l’événement copié sur un calendrier secondaire (pool).
 * @param poolCal ID déjà normalisé (ex. via normalizeGoogleCalendarId).
 * @param poolEventIdCandidates ids connus (client + base), essayés en PATCH avant recherche par `planningEventId` puis POST.
 */
async function createOrUpdatePoolCalendarEventCopy(
    accessToken: string,
    poolCal: string,
    poolEventIdCandidates: string[],
    baseFields: EventPayloadInput
): Promise<string> {
    const poolPayload = googleEventResource(
        { ...baseFields, poolGoogleEventId: undefined },
        { forPoolCalendarWrite: true }
    );
    const encPool = encodeURIComponent(poolCal);
    const candidates = dedupeGoogleEventIds(poolEventIdCandidates);
    const planningUuid = String(baseFields.planningEventId ?? '').trim();

    for (const poolOutId of candidates) {
        const encEid = encodeURIComponent(poolOutId);
        const patchP = await gcalFetch(accessToken, `/calendars/${encPool}/events/${encEid}`, {
            method: 'PATCH',
            body: JSON.stringify(poolPayload)
        });
        if (patchP.ok) return poolOutId;
        if (patchP.status !== 404) {
            console.error('[calendar-bridge] PATCH miroir pool:', patchP.status, await patchP.text());
            return '';
        }
    }

    if (planningUuid) {
        const found = await listEventIdsByPlanningPrivateProperty(accessToken, poolCal, planningUuid);
        if (found.length > 0) {
            const keep = found[0];
            const encKeep = encodeURIComponent(keep);
            const patchK = await gcalFetch(accessToken, `/calendars/${encPool}/events/${encKeep}`, {
                method: 'PATCH',
                body: JSON.stringify(poolPayload)
            });
            if (patchK.ok) {
                for (const extra of found.slice(1)) {
                    await deleteGoogleCalendarEventQuiet(accessToken, poolCal, extra);
                }
                return keep;
            }
            console.warn(
                '[calendar-bridge] PATCH miroir pool (retrouvé par planningEventId):',
                patchK.status,
                await patchK.text()
            );
        }
    }

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
        return '';
    }
    return created.id || '';
}

type PoolStudentMirrorRow = {
    target_user_id: string;
    google_calendar_id: string;
    google_event_id: string;
};

async function fetchPlanningMirrorPoolStudentRows(
    supabaseUrl: string,
    serviceKey: string,
    planningEventId: string
): Promise<PoolStudentMirrorRow[]> {
    const base = supabaseUrl.replace(/\/$/, '');
    const res = await fetch(
        `${base}/rest/v1/planning_event_google_mirror?event_id=eq.${encodeURIComponent(planningEventId)}&target=eq.pool_student&select=target_user_id,google_calendar_id,google_event_id,sync_status`,
        {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
        }
    );
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{
        target_user_id?: string;
        google_calendar_id?: string;
        google_event_id?: string;
        sync_status?: string;
    }>;
    if (!Array.isArray(arr)) return [];
    const out: PoolStudentMirrorRow[] = [];
    for (const r of arr) {
        const uid = String(r.target_user_id || '').trim();
        const cal = String(r.google_calendar_id || '').trim();
        const ge = String(r.google_event_id || '').trim();
        if (!uid) continue;
        out.push({ target_user_id: uid, google_calendar_id: cal, google_event_id: ge });
    }
    return out;
}

async function deleteGoogleCalendarEventQuiet(
    accessToken: string,
    calendarId: string,
    googleEventId: string
): Promise<void> {
    const encCal = encodeURIComponent(normalizeGoogleCalendarId(calendarId) || calendarId);
    const encEid = encodeURIComponent(googleEventId);
    const res = await gcalFetch(accessToken, `/calendars/${encCal}/events/${encEid}`, {
        method: 'DELETE'
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
        console.warn('[calendar-bridge] DELETE miroir pool élève:', res.status, await res.text());
    }
}

async function deletePlanningMirrorPoolStudentRow(
    supabaseUrl: string,
    serviceKey: string,
    planningEventId: string,
    targetUserId: string
): Promise<void> {
    const base = supabaseUrl.replace(/\/$/, '');
    const q = `${base}/rest/v1/planning_event_google_mirror?event_id=eq.${encodeURIComponent(planningEventId)}&target=eq.pool_student&target_user_id=eq.${encodeURIComponent(targetUserId)}`;
    const res = await fetch(q, {
        method: 'DELETE',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (!res.ok) {
        console.warn('[calendar-bridge] DELETE mirror pool_student:', res.status, await res.text());
    }
}

/**
 * Miroirs agenda secondaire pour chaque élève inscrit (cours). Nettoie les retraits.
 */
async function syncCoursStudentPoolMirrors(
    accessToken: string,
    jwt: string,
    supabaseUrl: string,
    supabaseAnonKey: string,
    serviceKey: string,
    planningEventId: string,
    mainCal: string,
    ownerPoolCalendarNorm: string,
    ev: NonNullable<BridgeBody['events']>[0]
): Promise<Array<{ target_user_id: string; google_calendar_id: string; google_event_id: string }>> {
    const clearAllStudentMirrors = async () => {
        const existing = await fetchPlanningMirrorPoolStudentRows(supabaseUrl, serviceKey, planningEventId);
        for (const row of existing) {
            if (row.google_calendar_id && row.google_event_id) {
                await deleteGoogleCalendarEventQuiet(
                    accessToken,
                    row.google_calendar_id,
                    row.google_event_id
                );
            }
            await deletePlanningMirrorPoolStudentRow(
                supabaseUrl,
                serviceKey,
                planningEventId,
                row.target_user_id
            );
        }
    };

    const st = String(ev.type || 'reservation').trim().toLowerCase();
    if (st !== 'cours') {
        await clearAllStudentMirrors();
        return [];
    }

    const emails = [...new Set(parseInscritsCsv(ev.inscrits))];
    if (emails.length === 0) {
        await clearAllStudentMirrors();
        return [];
    }

    const mainNorm = resolveCalendarId(mainCal).trim().toLowerCase();
    const ownerPoolNorm = ownerPoolCalendarNorm.trim().toLowerCase();

    const desired = new Map<string, { email: string; poolCal: string }>();

    for (const email of emails) {
        const uid = await fetchPlanningUserIdForEmail(supabaseUrl, supabaseAnonKey, jwt, email);
        if (!uid) {
            console.warn('[calendar-bridge] inscrit sans user id (e-mail ignoré pour miroir pool):', email);
            continue;
        }
        const poolRaw = await fetchPlanningPoolCalendarIdForOwnerEmail(
            supabaseUrl,
            supabaseAnonKey,
            jwt,
            email
        );
        const poolCal = normalizeGoogleCalendarId(poolRaw);
        if (!poolCal) {
            console.warn('[calendar-bridge] pas de calendrier pool pour inscrit:', email);
            continue;
        }
        const poolNorm = poolCal.trim().toLowerCase();
        if (poolNorm === mainNorm) continue;
        if (ownerPoolNorm && poolNorm === ownerPoolNorm) continue;
        desired.set(uid, { email, poolCal });
    }

    const existingRows = await fetchPlanningMirrorPoolStudentRows(supabaseUrl, serviceKey, planningEventId);
    const existingByUid = new Map(existingRows.map((r) => [r.target_user_id, r]));

    for (const row of existingRows) {
        if (!desired.has(row.target_user_id)) {
            if (row.google_calendar_id && row.google_event_id) {
                await deleteGoogleCalendarEventQuiet(
                    accessToken,
                    row.google_calendar_id,
                    row.google_event_id
                );
            }
            await deletePlanningMirrorPoolStudentRow(
                supabaseUrl,
                serviceKey,
                planningEventId,
                row.target_user_id
            );
        }
    }

    const baseFields: EventPayloadInput = {
        title: String(ev.title || '').trim(),
        start: String(ev.start || ''),
        end: String(ev.end || ''),
        type: String(ev.type || 'reservation'),
        owner: String(ev.owner || ''),
        inscrits: ev.inscrits,
        templateLineId: ev.templateLineId,
        ...(planningEventId.trim() ? { planningEventId: planningEventId.trim() } : {})
    };

    const results: Array<{ target_user_id: string; google_calendar_id: string; google_event_id: string }> =
        [];

    for (const [uid, meta] of desired) {
        const prior = existingByUid.get(uid);
        const gid = await createOrUpdatePoolCalendarEventCopy(
            accessToken,
            meta.poolCal,
            dedupeGoogleEventIds([prior?.google_event_id ?? '']),
            baseFields
        );
        if (!gid) {
            console.warn('[calendar-bridge] échec miroir pool élève (uid):', uid.slice(0, 8));
            continue;
        }
        results.push({
            target_user_id: uid,
            google_calendar_id: meta.poolCal,
            google_event_id: gid
        });
    }

    return results;
}

/**
 * Après écriture sur le calendrier principal : copie sur l’agenda Google « pool » du **propriétaire**
 * du créneau (`ev.owner`). Même compte que le JWT → RPC par user id ; prof/admin pour un élève → RPC par e-mail.
 */
async function mirrorOwnerPersonalCalendarIfNeeded(
    accessToken: string,
    user: { id: string; email?: string },
    jwt: string,
    supabaseUrl: string,
    supabaseAnonKey: string,
    ev: NonNullable<BridgeBody['events']>[0],
    body: BridgeBody,
    mainCalendarEventId: string,
    poolMirrorGoogleIdFromDb: string
): Promise<{ poolGoogleEventId: string; poolCalendarId: string } | null> {
    if (!supabaseUrl || !supabaseAnonKey || !user.id) {
        console.warn('[calendar-bridge] mirror skip: supabase url/anon key ou user.id manquant');
        return null;
    }
    const me = String(user.email || '').trim().toLowerCase();
    /* Ne pas exiger l’e-mail dans le JWT : les RPC pool utilisent auth.uid() et auth.users pour le propriétaire. */

    const mainCal = calendarId();
    const targetCal = resolveCalendarId(ev.calendarId ?? body.calendarId);
    if (!sameGoogleCalendarId(targetCal, mainCal)) return null;

    const ownerTrim = String(ev.owner || '').trim();
    const ownerNorm = ownerTrim.toLowerCase();
    const st = String(ev.type || 'reservation').trim().toLowerCase();
    if (st === 'fermeture') return null;

    let poolCalRaw = '';
    if (!ownerNorm || (me && ownerNorm === me)) {
        poolCalRaw = await fetchPlanningPoolCalendarId(supabaseUrl, supabaseAnonKey, jwt, user.id);
    } else {
        poolCalRaw = await fetchPlanningPoolCalendarIdForOwnerEmail(
            supabaseUrl,
            supabaseAnonKey,
            jwt,
            ownerTrim
        );
    }

    const poolCal = normalizeGoogleCalendarId(poolCalRaw);
    if (!poolCal || sameGoogleCalendarId(poolCal, mainCal)) {
        console.warn('[calendar-bridge] mirror skip: pas de calendrier pool pour le propriétaire ou id = principal', {
            ownerForPool: ownerNorm || me || '(uid seul)',
            poolRawLen: String(poolCalRaw).length,
            poolCal: poolCal ? poolCal.slice(0, 48) + '…' : ''
        });
        return null;
    }

    const title = String(ev.title || '').trim();
    const start = ev.start;
    const end = ev.end;
    if (!title || !start || !end) return null;

    const planningPid = String(ev.planningEventId ?? '').trim();
    const baseFields: EventPayloadInput = {
        title,
        start,
        end,
        type: String(ev.type || 'reservation'),
        owner: String(ev.owner || ''),
        inscrits: ev.inscrits,
        templateLineId: ev.templateLineId,
        ...(planningPid ? { planningEventId: planningPid } : {})
    };

    const poolOutId = await createOrUpdatePoolCalendarEventCopy(
        accessToken,
        poolCal,
        dedupeGoogleEventIds([
            String(ev.poolGoogleEventId ?? '').trim(),
            String(poolMirrorGoogleIdFromDb ?? '').trim()
        ]),
        baseFields
    );

    if (!poolOutId) return null;

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

    return { poolGoogleEventId: poolOutId, poolCalendarId: poolCal };
}

async function fetchPlanningEventSyncGeneration(
    supabaseUrl: string,
    serviceKey: string,
    eventId: string
): Promise<number | null> {
    const base = supabaseUrl.replace(/\/$/, '');
    const res = await fetch(
        `${base}/rest/v1/planning_event?id=eq.${encodeURIComponent(eventId)}&select=sync_generation`,
        {
            headers: {
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`
            }
        }
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ sync_generation?: number }>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const g = arr[0]?.sync_generation;
    return typeof g === 'number' ? g : null;
}

async function persistPlanningMirrorRows(
    supabaseUrl: string,
    serviceKey: string,
    planningEventId: string,
    mainCalendarId: string,
    mainGoogleEventId: string,
    pool: { googleEventId: string; calendarId: string } | null,
    poolStudents: Array<{ target_user_id: string; google_calendar_id: string; google_event_id: string }>
): Promise<void> {
    const gen = await fetchPlanningEventSyncGeneration(supabaseUrl, serviceKey, planningEventId);
    if (gen == null) {
        console.warn('[calendar-bridge] persist mirror skip: planning_event introuvable ou sync_generation', planningEventId);
        return;
    }
    const base = supabaseUrl.replace(/\/$/, '');
    const now = new Date().toISOString();
    const rows: Record<string, unknown>[] = [
        {
            event_id: planningEventId,
            target: 'main',
            google_calendar_id: mainCalendarId,
            google_event_id: mainGoogleEventId,
            sync_status: 'ok',
            last_error: null,
            sync_generation: gen,
            updated_at: now
        }
    ];
    if (pool?.googleEventId && pool?.calendarId) {
        rows.push({
            event_id: planningEventId,
            target: 'pool_owner',
            google_calendar_id: pool.calendarId,
            google_event_id: pool.googleEventId,
            sync_status: 'ok',
            last_error: null,
            sync_generation: gen,
            updated_at: now
        });
    }
    const res = await fetch(`${base}/rest/v1/planning_event_google_mirror?on_conflict=event_id,target`, {
        method: 'POST',
        headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify(rows)
    });
    if (!res.ok) {
        console.error('[calendar-bridge] persist planning_event_google_mirror (main/owner):', res.status, await res.text());
    }

    if (poolStudents.length === 0) return;

    const studentRows: Record<string, unknown>[] = poolStudents.map((s) => ({
        event_id: planningEventId,
        target: 'pool_student',
        target_user_id: s.target_user_id,
        google_calendar_id: s.google_calendar_id,
        google_event_id: s.google_event_id,
        sync_status: 'ok',
        last_error: null,
        sync_generation: gen,
        updated_at: now
    }));
    const resSt = await fetch(
        `${base}/rest/v1/planning_event_google_mirror?on_conflict=event_id,target_user_id`,
        {
            method: 'POST',
            headers: {
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates'
            },
            body: JSON.stringify(studentRows)
        }
    );
    if (!resSt.ok) {
        console.error('[calendar-bridge] persist planning_event_google_mirror (élèves):', resSt.status, await resSt.text());
    }
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function assertPlanningAdmin(
    supabaseUrl: string,
    anonKey: string,
    jwt: string,
    userId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const base = supabaseUrl.replace(/\/$/, '');
    const res = await fetch(
        `${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role`,
        {
            headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` }
        }
    );
    if (!res.ok) {
        return { ok: false, status: 403, error: 'Profil indisponible' };
    }
    const arr = (await res.json()) as Array<{ role?: string }>;
    const role = arr[0]?.role;
    if (role !== 'admin') {
        return { ok: false, status: 403, error: 'Forbidden: admin only' };
    }
    return { ok: true };
}

async function fetchAssignedPoolCalendarIdsForWipe(supabaseUrl: string, serviceKey: string): Promise<string[]> {
    if (!serviceKey.trim()) return [];
    const base = supabaseUrl.replace(/\/$/, '');
    const res = await fetch(
        `${base}/rest/v1/google_calendar_pool?assigned_user_id=not.is.null&select=google_calendar_id`,
        {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
        }
    );
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{ google_calendar_id?: string }>;
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const r of arr) {
        const id = String(r.google_calendar_id ?? '').trim();
        if (id) out.push(id);
    }
    return out;
}

function uniqueNormCalendarIds(ids: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of ids) {
        const n = normalizeGoogleCalendarId(raw) || raw.trim();
        if (!n) continue;
        const k = n.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(n);
    }
    return out;
}

async function listAllEventsInRangePaged(
    accessToken: string,
    rawCalendarId: string,
    timeMin: string,
    timeMax: string
): Promise<GCalEvent[]> {
    const encCal = encodeURIComponent(normalizeGoogleCalendarId(rawCalendarId) || rawCalendarId);
    const collected: GCalEvent[] = [];
    let pageToken: string | undefined;
    for (;;) {
        const params = new URLSearchParams({
            timeMin,
            timeMax,
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: '250'
        });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await gcalFetch(accessToken, `/calendars/${encCal}/events?${params}`);
        const data = (await res.json()) as {
            items?: GCalEvent[];
            nextPageToken?: string;
            error?: { message?: string };
        };
        if (!res.ok) {
            throw new Error(data.error?.message || `List HTTP ${res.status}`);
        }
        for (const it of data.items ?? []) {
            if (it?.id) collected.push(it);
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
    }
    return collected;
}

async function deleteGoogleEventIdInCalendar(
    accessToken: string,
    rawCalendarId: string,
    eventId: string
): Promise<boolean> {
    const encCal = encodeURIComponent(normalizeGoogleCalendarId(rawCalendarId) || rawCalendarId);
    const encEid = encodeURIComponent(eventId);
    const res = await gcalFetch(accessToken, `/calendars/${encCal}/events/${encEid}`, {
        method: 'DELETE'
    });
    return res.status === 204 || res.ok || res.status === 404 || res.status === 410;
}

function isGoogleCalendarRateLimited(status: number, bodyText: string): boolean {
    if (status === 429) return true;
    if (status !== 403) return false;
    try {
        const j = JSON.parse(bodyText) as {
            error?: { errors?: Array<{ reason?: string }>; message?: string };
        };
        const reasons = j.error?.errors?.map((e) => e.reason) ?? [];
        if (reasons.some((x) => x === 'rateLimitExceeded' || x === 'userRateLimitExceeded')) return true;
        const m = String(j.error?.message || '');
        return /rate limit|quota/i.test(m);
    } catch {
        return /rate limit|quota|usageLimits/i.test(bodyText);
    }
}

/**
 * IDs Google fiables pour PATCH (évite POST = doublon si le client n’a pas reçu les ids via RPC car sync_status ≠ ok).
 */
async function fetchPlanningMirrorGoogleIdsForUpsert(
    supabaseUrl: string,
    serviceKey: string,
    planningEventId: string
): Promise<{ main: string; poolOwner: string }> {
    const out = { main: '', poolOwner: '' };
    if (!supabaseUrl || !serviceKey.trim() || !planningEventId.trim()) return out;
    const base = supabaseUrl.replace(/\/$/, '');
    const res = await fetch(
        `${base}/rest/v1/planning_event_google_mirror?event_id=eq.${encodeURIComponent(planningEventId)}&select=target,google_event_id`,
        {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
        }
    );
    if (!res.ok) {
        console.warn('[calendar-bridge] fetch mirror ids', res.status, await res.text());
        return out;
    }
    const arr = (await res.json()) as Array<{ target?: string; google_event_id?: string | null }>;
    if (!Array.isArray(arr)) return out;
    for (const r of arr) {
        const ge = String(r.google_event_id ?? '').trim();
        if (!ge) continue;
        const t = String(r.target ?? '');
        if (t === 'main') out.main = ge;
        if (t === 'pool_owner') out.poolOwner = ge;
    }
    return out;
}

/**
 * Un seul événement : évite Promise.all (centaines d’appels Google en parallèle → Rate Limit Exceeded).
 */
async function upsertSingleCalendarEvent(
    accessToken: string,
    calendarUser: { id: string; email?: string },
    jwt: string,
    supabaseUrl: string,
    supabaseAnonKey: string,
    ev: NonNullable<BridgeBody['events']>[0],
    body: BridgeBody
): Promise<{ googleEventId: string; start: string; end: string; poolGoogleEventId?: string }> {
    const title = String(ev.title || '').trim();
    const start = ev.start;
    const end = ev.end;
    if (!title || !start || !end) {
        throw new Error('Champs title, start et end requis pour chaque événement');
    }

    const serviceKeyMerge = (
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
        Deno.env.get('SERVICE_ROLE_KEY') ??
        ''
    ).trim();
    const planningIdMerge = String(ev.planningEventId ?? '').trim();
    let mid = { main: '', poolOwner: '' };
    if (planningIdMerge && serviceKeyMerge && supabaseUrl) {
        mid = await fetchPlanningMirrorGoogleIdsForUpsert(
            supabaseUrl,
            serviceKeyMerge,
            planningIdMerge
        );
    }

    const calIdUpsert = encodeURIComponent(resolveCalendarId(ev.calendarId ?? body.calendarId));
    const mainCalResolved = resolveCalendarId(ev.calendarId ?? body.calendarId);
    const poolLinkForMain = String(mid.poolOwner || ev.poolGoogleEventId || '').trim();

    const mainPayloadBase: EventPayloadInput = {
        title,
        start,
        end,
        type: String(ev.type || 'reservation'),
        owner: String(ev.owner || ''),
        inscrits: ev.inscrits,
        templateLineId: ev.templateLineId,
        ...(poolLinkForMain ? { poolGoogleEventId: poolLinkForMain } : {}),
        ...(planningIdMerge ? { planningEventId: planningIdMerge } : {})
    };
    const payload = googleEventResource(mainPayloadBase);

    let mainOutId = '';
    const mainCandidates = dedupeGoogleEventIds([mid.main, ev.googleEventId]);

    for (const tryGid of mainCandidates) {
        const encEid = encodeURIComponent(tryGid);
        for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) await sleepMs(Math.min(2500, 350 * 2 ** (attempt - 1)));
            const patch = await gcalFetch(accessToken, `/calendars/${calIdUpsert}/events/${encEid}`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
            const pt = await patch.text();
            if (patch.ok) {
                mainOutId = tryGid;
                break;
            }
            if (patch.status === 404) break;
            if (isGoogleCalendarRateLimited(patch.status, pt) && attempt < 4) continue;
            throw new Error(pt.slice(0, 200) || `PATCH ${patch.status}`);
        }
        if (mainOutId) break;
    }

    if (!mainOutId && planningIdMerge) {
        const foundMain = await listEventIdsByPlanningPrivateProperty(
            accessToken,
            mainCalResolved,
            planningIdMerge
        );
        if (foundMain.length > 0) {
            const keep = foundMain[0];
            const encEid = encodeURIComponent(keep);
            for (let attempt = 0; attempt < 5; attempt++) {
                if (attempt > 0) await sleepMs(Math.min(2500, 350 * 2 ** (attempt - 1)));
                const patch = await gcalFetch(accessToken, `/calendars/${calIdUpsert}/events/${encEid}`, {
                    method: 'PATCH',
                    body: JSON.stringify(payload)
                });
                const pt = await patch.text();
                if (patch.ok) {
                    mainOutId = keep;
                    break;
                }
                if (patch.status === 404) break;
                if (isGoogleCalendarRateLimited(patch.status, pt) && attempt < 4) continue;
                throw new Error(pt.slice(0, 200) || `PATCH ${patch.status}`);
            }
            if (mainOutId) {
                for (const extra of foundMain.slice(1)) {
                    await deleteGoogleCalendarEventQuiet(accessToken, mainCalResolved, extra);
                }
            }
        }
    }

    if (!mainOutId) {
        let lastErr = '';
        for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) await sleepMs(Math.min(3000, 400 * 2 ** (attempt - 1)));
            const ins = await gcalFetch(accessToken, `/calendars/${calIdUpsert}/events`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            const raw = await ins.text();
            let created: GCalEvent & { error?: { message?: string } };
            try {
                created = JSON.parse(raw) as GCalEvent & { error?: { message?: string } };
            } catch {
                throw new Error(raw.slice(0, 200) || `POST HTTP ${ins.status}`);
            }
            if (ins.ok && created.id) {
                mainOutId = created.id || '';
                break;
            }
            lastErr = created.error?.message || `POST événement HTTP ${ins.status}`;
            if (isGoogleCalendarRateLimited(ins.status, raw) && attempt < 5) continue;
            throw new Error(lastErr);
        }
        if (!mainOutId) throw new Error(lastErr || 'Création événement impossible');
    }

    const poolPair = await mirrorOwnerPersonalCalendarIfNeeded(
        accessToken,
        calendarUser,
        jwt,
        supabaseUrl,
        supabaseAnonKey,
        ev,
        body,
        mainOutId,
        mid.poolOwner
    );

    const planningId = String(ev.planningEventId ?? '').trim();
    /* Secret manuel Edge : le dashboard refuse SUPABASE_* → SERVICE_ROLE_KEY (même JWT que la clé service_role). */
    const serviceKey = (
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
        Deno.env.get('SERVICE_ROLE_KEY') ??
        ''
    ).trim();
    let poolStudents: Array<{ target_user_id: string; google_calendar_id: string; google_event_id: string }> =
        [];
    if (planningId && serviceKey && supabaseUrl && supabaseAnonKey) {
        const ownerPoolNorm = poolPair?.poolCalendarId
            ? normalizeGoogleCalendarId(poolPair.poolCalendarId).trim().toLowerCase()
            : '';
        poolStudents = await syncCoursStudentPoolMirrors(
            accessToken,
            jwt,
            supabaseUrl,
            supabaseAnonKey,
            serviceKey,
            planningId,
            mainCalResolved,
            ownerPoolNorm,
            ev
        );
    }
    if (planningId && serviceKey) {
        await persistPlanningMirrorRows(
            supabaseUrl,
            serviceKey,
            planningId,
            mainCalResolved,
            mainOutId,
            poolPair,
            poolStudents
        );
    } else if (planningId && !serviceKey) {
        console.warn(
            '[calendar-bridge] Clé service_role absente (SUPABASE_SERVICE_ROLE_KEY auto ou secret Edge SERVICE_ROLE_KEY) — planning_event_google_mirror ignoré'
        );
    }

    return {
        googleEventId: mainOutId,
        start,
        end,
        ...(poolPair?.poolGoogleEventId ? { poolGoogleEventId: poolPair.poolGoogleEventId } : {})
    };
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
            /* Déjà supprimé manuellement ou expiré : idempotent côté appli (suite = DELETE base). */
            if (res.status === 404 || res.status === 410) {
                return jsonResponse({ ok: true, alreadyGone: true });
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

        if (action === 'adminWipeCalendarsInRange') {
            const timeMin = String(body.timeMin ?? '').trim();
            const timeMax = String(body.timeMax ?? '').trim();
            if (!timeMin || !timeMax) {
                return jsonResponse({ ok: false, error: 'timeMin et timeMax requis (ISO 8601)' }, 400);
            }
            const adminGate = await assertPlanningAdmin(supabaseUrl, supabaseAnonKey, jwt, user.id);
            if (!adminGate.ok) {
                return jsonResponse({ ok: false, error: adminGate.error }, adminGate.status);
            }

            const serviceKey = (
                Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
                Deno.env.get('SERVICE_ROLE_KEY') ??
                ''
            ).trim();
            let mainCal: string;
            try {
                mainCal = calendarId();
            } catch (e) {
                return jsonResponse(
                    {
                        ok: false,
                        error: e instanceof Error ? e.message : 'GOOGLE_CALENDAR_ID manquant'
                    },
                    500
                );
            }
            const poolIds = await fetchAssignedPoolCalendarIdsForWipe(supabaseUrl, serviceKey);
            const allCalendars = uniqueNormCalendarIds([mainCal, ...poolIds]);

            const deletedByCalendar: Record<string, number> = {};
            const calendarErrors: string[] = [];

            for (const cal of allCalendars) {
                try {
                    const items = await listAllEventsInRangePaged(accessToken, cal, timeMin, timeMax);
                    let n = 0;
                    for (const ev of items) {
                        const eid = ev.id?.trim();
                        if (!eid) continue;
                        const okDel = await deleteGoogleEventIdInCalendar(accessToken, cal, eid);
                        if (okDel) n++;
                        await sleepMs(35);
                    }
                    deletedByCalendar[cal] = n;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    calendarErrors.push(`${cal}: ${msg}`);
                }
            }

            return jsonResponse({
                ok: true,
                deletedByCalendar,
                ...(calendarErrors.length > 0 ? { errors: calendarErrors } : {})
            });
        }

        if (action === 'upsert' && body.events && body.events.length > 0) {
            const results: Array<{ googleEventId: string; start: string; end: string; poolGoogleEventId?: string }> =
                [];
            /** Écart entre événements pour limiter les rafales (quota Google Calendar). */
            const gapMs = 55;
            for (let i = 0; i < body.events.length; i++) {
                if (i > 0) await sleepMs(gapMs);
                const row = await upsertSingleCalendarEvent(
                    accessToken,
                    calendarUser,
                    jwt,
                    supabaseUrl,
                    supabaseAnonKey,
                    body.events[i],
                    body
                );
                results.push(row);
            }
            return jsonResponse({ ok: true, results });
        }

        return jsonResponse({ ok: false, error: 'Action ou payload inconnu' }, 400);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return jsonResponse({ ok: false, error: msg }, 500);
    }
});
