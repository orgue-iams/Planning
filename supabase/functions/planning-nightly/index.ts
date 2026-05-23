/**
 * Rapport nocturne (cron) : santé, digest erreurs infra, audit miroirs Google, réparation, contrôle final.
 * Mode `ciFailure` : alerte e-mail vers planning_error_notify_email (échec CI GitHub).
 * Auth : Authorization: Bearer <PLANNING_CRON_SECRET>
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret'
};

const AUDIT_HORIZON_DAYS = 30;
const MAX_EVENTS_SCAN = 500;
const MAX_LIST_ROWS = 250;

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' }
    });
}

function escapeHtml(s: string) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normalizeBrevoApiKey(raw: string | undefined): string {
    return String(raw ?? '')
        .trim()
        .replace(/^["']|["']$/g, '');
}

type CiFailurePayload = {
    workflowName?: string;
    runUrl?: string;
    branch?: string;
    sha?: string;
    errorSummary?: string;
};

type PlanningEventRow = {
    id: string;
    start_at: string;
    end_at: string;
    title: string;
    slot_type: string;
    owner_email: string;
    owner_user_id: string;
};

type MirrorRow = {
    event_id: string;
    target: string;
    sync_status: string;
    last_error: string | null;
    google_calendar_id: string | null;
    target_user_id: string | null;
};

type AuditResult = {
    missingMain: PlanningEventRow[];
    missingPoolOwner: PlanningEventRow[];
    mirrorErrors: MirrorRow[];
};

type PoolCalendarInfo = {
    userId: string;
    calendarId: string;
    label: string;
    userLabel: string;
};

type CalendarDirectory = {
    main: { label: string; userLabel: string };
    poolsByUserId: Map<string, PoolCalendarInfo>;
    poolByCalendarId: Map<string, PoolCalendarInfo>;
};

type CalendarAuditBucket = {
    calLabel: string;
    userLabel: string;
    missingMain: PlanningEventRow[];
    missingPool: PlanningEventRow[];
    mirrorErrors: MirrorRow[];
};

type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';

/** Une ligne du tableau de synthèse (section 1 du rapport). */
type ControlCheck = {
    id: string;
    label: string;
    description: string;
    status: CheckStatus;
    detail?: string;
};

function statusLabelFr(status: CheckStatus): string {
    switch (status) {
        case 'ok':
            return 'OK';
        case 'warn':
            return 'Attention';
        case 'error':
            return 'Échec';
        case 'skip':
            return 'Non exécuté';
    }
}

function renderControlsTable(checks: ControlCheck[]): string {
    if (!checks.length) {
        return '<p>Aucun contrôle enregistré.</p>';
    }
    const rows = checks
        .map(
            (c) => `<tr>
<td>${escapeHtml(c.label)}</td>
<td><strong>${escapeHtml(statusLabelFr(c.status))}</strong></td>
<td>${escapeHtml(c.description)}${c.detail ? `<br/><em>${escapeHtml(c.detail)}</em>` : ''}</td>
</tr>`
        )
        .join('\n');
    return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:960px;font-size:14px;">
<thead><tr><th align="left">Contrôle</th><th align="left">Statut</th><th align="left">Résultat</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

async function sendBrevoHtml(notifyEmail: string, subject: string, htmlBody: string) {
    const apiKey = normalizeBrevoApiKey(Deno.env.get('BREVO_API_KEY'));
    const fromEmail = String(Deno.env.get('NOTIFY_FROM_EMAIL') ?? '').trim();
    const fromName = String(Deno.env.get('NOTIFY_FROM_NAME') ?? 'Planning Orgue IAMS').trim();
    if (!apiKey || !fromEmail) {
        return { ok: false as const, error: 'BREVO_API_KEY ou NOTIFY_FROM_EMAIL manquant' };
    }

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'api-key': apiKey
        },
        body: JSON.stringify({
            sender: { name: fromName, email: fromEmail },
            to: [{ email: notifyEmail }],
            subject,
            htmlContent: htmlBody
        })
    });

    if (!brevoRes.ok) {
        const t = await brevoRes.text();
        return { ok: false as const, error: 'BREVO_SEND_FAILED', detail: t.slice(0, 350) };
    }
    return { ok: true as const };
}

async function resolveNotifyEmail(admin: ReturnType<typeof createClient>) {
    const { data: settings } = await admin
        .from('organ_school_settings')
        .select('planning_error_notify_email')
        .limit(1)
        .maybeSingle();
    return String(settings?.planning_error_notify_email ?? '')
        .trim()
        .toLowerCase();
}

function formatSlotFr(iso: string): string {
    try {
        return new Date(iso).toLocaleString('fr-FR', {
            timeZone: 'Europe/Paris',
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return String(iso);
    }
}

function needsPoolMirror(slotType: string): boolean {
    const s = String(slotType || '').toLowerCase();
    if (s === 'fermeture' || s === 'concert' || s === 'autre') return false;
    if (s === 'cours' || s === 'travail perso') return true;
    return false;
}

async function loadFutureEvents(
    admin: ReturnType<typeof createClient>,
    nowIso: string,
    horizonIso: string
): Promise<PlanningEventRow[]> {
    const { data } = await admin
        .from('planning_event')
        .select('id, start_at, end_at, title, slot_type, owner_email, owner_user_id')
        .gte('start_at', nowIso)
        .lte('start_at', horizonIso)
        .order('start_at', { ascending: true })
        .limit(MAX_EVENTS_SCAN);
    return (data ?? []).map((e) => ({
        id: String(e.id),
        start_at: String(e.start_at),
        end_at: String(e.end_at),
        title: String(e.title || '').trim() || 'Créneau',
        slot_type: String(e.slot_type || ''),
        owner_email: String(e.owner_email || ''),
        owner_user_id: String(e.owner_user_id || '')
    }));
}

async function loadPoolUserIds(admin: ReturnType<typeof createClient>): Promise<Set<string>> {
    const { data: poolAssign } = await admin
        .from('google_calendar_pool')
        .select('assigned_user_id')
        .not('assigned_user_id', 'is', null);
    return new Set(
        (poolAssign ?? []).map((r) => String(r.assigned_user_id || '').trim()).filter(Boolean)
    );
}

async function loadCalendarDirectory(
    admin: ReturnType<typeof createClient>
): Promise<CalendarDirectory> {
    const main = {
        label: 'Calendrier principal orgue IAMS',
        userLabel: 'Institut — reflet de tous les créneaux en base (cours, travail perso, autres, concerts, fermetures)'
    };
    const { data: pools } = await admin
        .from('google_calendar_pool')
        .select('assigned_user_id, google_calendar_id, label')
        .not('assigned_user_id', 'is', null);

    const userIds = [
        ...new Set(
            (pools ?? []).map((p) => String(p.assigned_user_id || '').trim()).filter(Boolean)
        )
    ];
    const profileById = new Map<string, string>();
    if (userIds.length) {
        const { data: profiles } = await admin
            .from('profiles')
            .select('id, prenom, nom, display_name')
            .in('id', userIds);
        for (const p of profiles ?? []) {
            const name =
                [p.prenom, p.nom].filter(Boolean).join(' ').trim() ||
                String(p.display_name || '').trim();
            if (name) profileById.set(String(p.id), name);
        }
    }

    const poolsByUserId = new Map<string, PoolCalendarInfo>();
    const poolByCalendarId = new Map<string, PoolCalendarInfo>();
    for (const p of pools ?? []) {
        const userId = String(p.assigned_user_id || '').trim();
        const calendarId = String(p.google_calendar_id || '').trim().toLowerCase();
        const label = String(p.label || '').trim() || 'Agenda pool';
        const userLabel = profileById.get(userId) || `Utilisateur ${userId.slice(0, 8)}…`;
        const info: PoolCalendarInfo = { userId, calendarId, label, userLabel };
        poolsByUserId.set(userId, info);
        if (calendarId) poolByCalendarId.set(calendarId, info);
    }
    return { main, poolsByUserId, poolByCalendarId };
}

function buildAuditBuckets(audit: AuditResult, directory: CalendarDirectory): CalendarAuditBucket[] {
    const map = new Map<string, CalendarAuditBucket>();

    const ensure = (key: string, calLabel: string, userLabel: string): CalendarAuditBucket => {
        let b = map.get(key);
        if (!b) {
            b = { calLabel, userLabel, missingMain: [], missingPool: [], mirrorErrors: [] };
            map.set(key, b);
        }
        return b;
    };

    const mainKey = '__main__';
    ensure(mainKey, directory.main.label, directory.main.userLabel);

    for (const ev of audit.missingMain) {
        ensure(mainKey, directory.main.label, directory.main.userLabel).missingMain.push(ev);
    }
    for (const ev of audit.missingPoolOwner) {
        const uid = String(ev.owner_user_id || '').trim();
        const pool = directory.poolsByUserId.get(uid);
        if (pool) {
            ensure(`pool:${uid}`, pool.label, pool.userLabel).missingPool.push(ev);
        } else {
            ensure('pool:unknown', 'Agenda pool (utilisateur inconnu)', uid || '?').missingPool.push(ev);
        }
    }
    for (const m of audit.mirrorErrors) {
        if (m.target === 'main') {
            ensure(mainKey, directory.main.label, directory.main.userLabel).mirrorErrors.push(m);
            continue;
        }
        const uid = String(m.target_user_id || '').trim();
        if (m.target === 'pool_owner' && uid) {
            const pool = directory.poolsByUserId.get(uid);
            if (pool) {
                ensure(`pool:${uid}`, pool.label, pool.userLabel).mirrorErrors.push(m);
                continue;
            }
        }
        const calId = String(m.google_calendar_id || '').trim().toLowerCase();
        const byCal = calId ? directory.poolByCalendarId.get(calId) : undefined;
        if (byCal) {
            ensure(`pool:${byCal.userId}`, byCal.label, byCal.userLabel).mirrorErrors.push(m);
        } else {
            ensure(
                `mirror:${m.event_id}:${m.target}`,
                `Miroir (${m.target})`,
                uid || calId.slice(0, 12) || '—'
            ).mirrorErrors.push(m);
        }
    }

    const buckets = [...map.values()].filter(
        (b) => b.missingMain.length + b.missingPool.length + b.mirrorErrors.length > 0
    );
    buckets.sort((a, b) => {
        const aMain = a.calLabel.includes('principal') ? 0 : 1;
        const bMain = b.calLabel.includes('principal') ? 0 : 1;
        if (aMain !== bMain) return aMain - bMain;
        return a.calLabel.localeCompare(b.calLabel, 'fr');
    });
    return buckets;
}

function renderAuditByCalendar(buckets: CalendarAuditBucket[], emptyMsg: string): string {
    if (!buckets.length) return `<p>${escapeHtml(emptyMsg)}</p>`;
    const parts: string[] = [];
    for (const b of buckets) {
        parts.push(
            `<h4>${escapeHtml(b.calLabel)} — ${escapeHtml(b.userLabel)}</h4>`
        );
        if (b.missingMain.length) {
            parts.push('<p><strong>Sans lien Google sur l’agenda principal</strong></p>');
            parts.push(renderEventList(b.missingMain, 'Aucun.'));
        }
        if (b.missingPool.length) {
            parts.push('<p><strong>Sans lien Google sur l’agenda perso (pool)</strong></p>');
            parts.push(renderEventList(b.missingPool, 'Aucun.'));
        }
        if (b.mirrorErrors.length) {
            parts.push('<p><strong>Miroirs en échec</strong></p>');
            parts.push(renderMirrorErrorList(b.mirrorErrors));
        }
    }
    return parts.join('\n');
}

function renderResyncedCalendars(repair: Record<string, unknown>): string {
    const detail = repair.resyncedCalendarsDetail;
    if (!Array.isArray(detail) || !detail.length) {
        return '<p>Aucun agenda resynchronisé (ou réparation non lancée).</p>';
    }
    const items = detail
        .map((row) => {
            const r = row as { label?: string; userLabel?: string; kind?: string };
            const lab = String(r.label || 'Agenda');
            const user = String(r.userLabel || '—');
            const kind =
                r.kind === 'main' ? 'calendrier principal' : 'agenda perso Planning IAMS';
            return `<li><strong>${escapeHtml(lab)}</strong> — ${escapeHtml(user)} <em>(${escapeHtml(kind)})</em></li>`;
        })
        .join('\n');
    return `<ul>${items}</ul>`;
}

async function auditMirrors(
    admin: ReturnType<typeof createClient>,
    events: PlanningEventRow[],
    poolUserIds: Set<string>
): Promise<AuditResult> {
    const eventIds = events.map((e) => e.id);
    let mirrors: MirrorRow[] = [];
    if (eventIds.length) {
        const { data: mir } = await admin
            .from('planning_event_google_mirror')
            .select('event_id, target, sync_status, last_error, google_calendar_id, target_user_id')
            .in('event_id', eventIds);
        mirrors = (mir ?? []).map((m) => ({
            event_id: String(m.event_id),
            target: String(m.target),
            sync_status: String(m.sync_status || ''),
            last_error: m.last_error != null ? String(m.last_error) : null,
            google_calendar_id:
                m.google_calendar_id != null ? String(m.google_calendar_id).trim().toLowerCase() : null,
            target_user_id: m.target_user_id != null ? String(m.target_user_id).trim() : null
        }));
    }

    const mainOk = new Set(
        mirrors
            .filter((m) => m.target === 'main' && m.sync_status === 'ok')
            .map((m) => m.event_id)
    );
    const poolOwnerOk = new Set(
        mirrors
            .filter((m) => m.target === 'pool_owner' && m.sync_status === 'ok')
            .map((m) => m.event_id)
    );
    const mirrorErrors = mirrors.filter((m) => m.sync_status && m.sync_status !== 'ok');

    const missingMain = events.filter((e) => !mainOk.has(e.id));
    const missingPoolOwner = events.filter((e) => {
        const st = String(e.slot_type || '').toLowerCase();
        if (!needsPoolMirror(st)) return false;
        const ownerId = String(e.owner_user_id || '').trim();
        if (!ownerId || !poolUserIds.has(ownerId)) return false;
        return !poolOwnerOk.has(e.id);
    });

    return { missingMain, missingPoolOwner, mirrorErrors };
}

function renderEventList(events: PlanningEventRow[], emptyMsg: string): string {
    if (!events.length) return `<p>${escapeHtml(emptyMsg)}</p>`;
    const rows = events.slice(0, MAX_LIST_ROWS);
    const truncated = events.length > MAX_LIST_ROWS;
    const items = rows
        .map(
            (ev) =>
                `<li><strong>${escapeHtml(ev.title)}</strong> — ${escapeHtml(formatSlotFr(ev.start_at))} — propriétaire ${escapeHtml(ev.owner_email || '?')} — <code>${escapeHtml(ev.id.slice(0, 8))}…</code></li>`
        )
        .join('\n');
    const more = truncated
        ? `<p><em>… et ${events.length - MAX_LIST_ROWS} autre(s) non listé(s) (plafond ${MAX_LIST_ROWS}).</em></p>`
        : '';
    return `<p><strong>${events.length}</strong> créneau(x) :</p><ul>${items}</ul>${more}`;
}

function renderMirrorErrorList(errors: MirrorRow[]): string {
    if (!errors.length) return '<p>Aucun miroir en statut d’erreur.</p>';
    const rows = errors.slice(0, MAX_LIST_ROWS);
    const items = rows
        .map(
            (m) =>
                `<li>Créneau <code>${escapeHtml(m.event_id.slice(0, 8))}…</code> — cible <strong>${escapeHtml(m.target)}</strong> — statut ${escapeHtml(m.sync_status)} ${m.last_error ? `— ${escapeHtml(m.last_error)}` : ''}</li>`
        )
        .join('\n');
    return `<ul>${items}</ul>`;
}

function glossaryHtml(): string {
    return `
<h3>Source de vérité et « miroirs » Google</h3>
<p><strong>La base (<code>planning_event</code>) fait toujours foi.</strong> On ne modifie pas les créneaux en base pour « coller » à Google : la réparation pousse la base vers Google.</p>
<p>La table <code>planning_event_google_mirror</code> n’est <em>pas</em> une copie du planning : c’est un <strong>registre de liaison</strong> (ID Google, statut de sync) pour savoir si un créneau est bien présent sur chaque agenda.</p>
<ul>
<li><strong>Agenda principal</strong> (<code>main</code>) — doit refléter <strong>tous</strong> les créneaux futurs en base : cours, travail perso, autres, concerts et <strong>fermetures</strong>.</li>
<li><strong>Agendas perso</strong> (<code>pool_owner</code>, libellés « Planning IAMS 01…26 ») — copie prof/élève pour les <strong>cours</strong> et le <strong>travail perso</strong> lorsqu’un pool est assigné.</li>
</ul>
<p><strong>Sans miroir OK</strong> = le créneau est en base mais Google n’est pas aligné (événement manquant ou lien cassé).</p>`;
}

async function handleCiFailure(notifyEmail: string, cf: CiFailurePayload) {
    const nowIso = new Date().toISOString();
    const lines: string[] = [];
    lines.push(`<p>Échec d’un workflow GitHub Actions — ${escapeHtml(nowIso)}</p>`);
    lines.push('<p>Ce message a été envoyé à l’adresse configurée dans l’application (<strong>Configuration du planning → Support technique</strong>), pas à l’e-mail du compte GitHub qui déclenche la CI.</p>');
    lines.push('<ul>');
    if (cf.workflowName) lines.push(`<li><strong>Workflow</strong> : ${escapeHtml(cf.workflowName)}</li>`);
    if (cf.branch) lines.push(`<li><strong>Branche</strong> : ${escapeHtml(cf.branch)}</li>`);
    if (cf.sha) lines.push(`<li><strong>Commit</strong> : <code>${escapeHtml(cf.sha)}</code></li>`);
    if (cf.runUrl) {
        lines.push(
            `<li><strong>Logs</strong> : <a href="${escapeHtml(cf.runUrl)}">${escapeHtml(cf.runUrl)}</a></li>`
        );
    }
    if (cf.errorSummary) {
        lines.push(`<li><strong>Résumé</strong> : ${escapeHtml(cf.errorSummary)}</li>`);
    }
    lines.push('</ul>');

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/></head><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222;">${lines.join('\n')}</body></html>`;
    const subject = `[Planning IAMS] Échec CI — ${String(cf.workflowName || 'workflow').slice(0, 80)}`;
    const sent = await sendBrevoHtml(notifyEmail, subject, html);
    if (!sent.ok) {
        return json({ ok: false, error: sent.error, detail: 'detail' in sent ? sent.detail : undefined }, 502);
    }
    return json({ ok: true, emailSent: true, notifyEmail, mode: 'ci_failure' });
}

async function runGoogleRepair(
    supabaseUrl: string,
    cronSecret: string,
    anonKey: string
): Promise<Record<string, unknown>> {
    try {
        const repairRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/calendar-bridge`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cronSecret}`,
                apikey: anonKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action: 'cron_repair_google_sync' })
        });
        const repairText = await repairRes.text();
        try {
            return repairText ? (JSON.parse(repairText) as Record<string, unknown>) : {};
        } catch {
            return { ok: false, error: repairText.slice(0, 200) };
        }
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

    const cronSecret = (
        Deno.env.get('PLANNING_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
    ).trim();
    const auth = String(req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const hdrSecret = String(req.headers.get('x-cron-secret') ?? '').trim();
    if (!cronSecret || (auth !== cronSecret && hdrSecret !== cronSecret)) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = (
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? ''
    ).trim();
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) {
        return json({ ok: false, error: 'Missing service configuration' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    const notifyEmail = await resolveNotifyEmail(admin);
    if (!notifyEmail) {
        return json({ ok: false, error: 'planning_error_notify_email non configuré' }, 400);
    }

    let payload: { ciFailure?: CiFailurePayload } = {};
    try {
        const ct = req.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            payload = await req.json();
        }
    } catch {
        /* corps vide = rapport nocturne standard */
    }

    if (payload.ciFailure && typeof payload.ciFailure === 'object') {
        return handleCiFailure(notifyEmail, payload.ciFailure);
    }

    const nowIso = new Date().toISOString();
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + AUDIT_HORIZON_DAYS);
    const horizonIso = horizon.toISOString();

    const checks: ControlCheck[] = [];
    const bodySections: string[] = [];

    checks.push({
        id: 'auth_cron',
        label: 'Authentification cron',
        description: 'Secret PLANNING_CRON_SECRET / en-tête Authorization.',
        status: 'ok'
    });
    checks.push({
        id: 'supabase_config',
        label: 'Configuration Supabase',
        description: 'URL projet + clé service role pour les requêtes admin.',
        status: 'ok'
    });
    checks.push({
        id: 'notify_email',
        label: 'E-mail d’alerte configuré',
        description: 'Champ organ_school_settings.planning_error_notify_email.',
        status: 'ok',
        detail: notifyEmail
    });

    const brevoKey = normalizeBrevoApiKey(Deno.env.get('BREVO_API_KEY'));
    const fromEmail = String(Deno.env.get('NOTIFY_FROM_EMAIL') ?? '').trim();
    checks.push({
        id: 'brevo_config',
        label: 'Configuration envoi e-mail (Brevo)',
        description: 'Variables BREVO_API_KEY et NOTIFY_FROM_EMAIL.',
        status: brevoKey && fromEmail ? 'ok' : 'error',
        detail:
            brevoKey && fromEmail
                ? `Expéditeur ${fromEmail}`
                : 'Clé API ou adresse expéditeur manquante — le rapport ne pourra pas partir.'
    });

    bodySections.push(`<p>Rapport automatique Planning IAMS — ${escapeHtml(nowIso)}</p>`);
    bodySections.push(
        `<p>Destinataire : <strong>${escapeHtml(notifyEmail)}</strong> (<code>planning_error_notify_email</code>).</p>`
    );
    bodySections.push(glossaryHtml());

    /* ——— Digest erreurs infra historiques ——— */
    const { data: pendingErrors, error: pendingErrorsErr } = await admin
        .from('planning_infra_error_log')
        .select('id, occurred_at, source, message, detail')
        .is('digest_sent_at', null)
        .order('occurred_at', { ascending: true })
        .limit(100);

    const pendingCount = (pendingErrors ?? []).length;
    checks.push({
        id: 'infra_log_read',
        label: 'Lecture journal infra',
        description: 'Table planning_infra_error_log (entrées non encore digérées).',
        status: pendingErrorsErr ? 'error' : 'ok',
        detail: pendingErrorsErr
            ? String(pendingErrorsErr.message)
            : `${pendingCount} entrée(s) en attente de digest`
    });
    checks.push({
        id: 'infra_log_pending',
        label: 'Erreurs infra historiques en attente',
        description:
            'Événements passés enregistrés par l’app ou un job ; pas forcément encore valides — voir contrôle final agendas.',
        status: pendingErrorsErr ? 'error' : pendingCount === 0 ? 'ok' : 'warn',
        detail:
            pendingCount === 0
                ? 'Aucune entrée à résumer ce run'
                : `${pendingCount} entrée(s) listée(s) en section 2`
    });

    bodySections.push(`<h3>2. Digest des erreurs infra (journal, avant ce run)</h3>`);
    bodySections.push(
        '<p>Entrées dans <code>planning_infra_error_log</code> pas encore envoyées dans un rapport précédent. Ce ne sont pas forcément des anomalies actuelles — voir le contrôle final (section 5).</p>'
    );
    if (!(pendingErrors ?? []).length) {
        bodySections.push('<p><strong>Aucune</strong> entrée en attente.</p>');
    } else {
        bodySections.push(`<p><strong>${pendingCount}</strong> entrée(s) :</p><ul>`);
        for (const row of pendingErrors ?? []) {
            bodySections.push(
                `<li><strong>${escapeHtml(String(row.source))}</strong> — ${escapeHtml(String(row.message))} <em>(${escapeHtml(String(row.occurred_at))})</em></li>`
            );
        }
        bodySections.push('</ul>');
    }

    const poolUserIds = await loadPoolUserIds(admin);
    const calendarDirectory = await loadCalendarDirectory(admin);
    const poolAssignedCount = calendarDirectory.poolsByUserId.size;

    checks.push({
        id: 'pool_directory',
        label: 'Agendas pool assignés (Planning IAMS)',
        description: 'Lecture google_calendar_pool + noms profils pour le rapport.',
        status: 'ok',
        detail: `${poolAssignedCount} agenda(s) pool avec utilisateur assigné`
    });

    const futureEvents = await loadFutureEvents(admin, nowIso, horizonIso);
    checks.push({
        id: 'events_load',
        label: 'Créneaux futurs en base',
        description: `planning_event sur ${AUDIT_HORIZON_DAYS} jours (max ${MAX_EVENTS_SCAN} lignes).`,
        status: 'ok',
        detail: `${futureEvents.length} créneau(x) chargé(s)`
    });

    /* ——— Audit AVANT réparation ——— */
    const auditBefore = await auditMirrors(admin, futureEvents, poolUserIds);
    const bucketsBefore = buildAuditBuckets(auditBefore, calendarDirectory);

    const auditBeforeIssueCount =
        auditBefore.missingMain.length +
        auditBefore.missingPoolOwner.length +
        auditBefore.mirrorErrors.length;

    checks.push({
        id: 'audit_main_before',
        label: 'Audit — agenda principal (avant réparation)',
        description:
            'Chaque créneau futur doit avoir un lien Google main OK (cours, travail perso, autres, concerts, fermetures).',
        status: auditBefore.missingMain.length === 0 ? 'ok' : 'warn',
        detail:
            auditBefore.missingMain.length === 0
                ? 'Tous les créneaux ont un lien principal OK'
                : `${auditBefore.missingMain.length} sans lien principal OK`
    });
    checks.push({
        id: 'audit_pool_before',
        label: 'Audit — agendas perso pool (avant réparation)',
        description: 'Cours et travail perso des utilisateurs avec un pool assigné.',
        status: auditBefore.missingPoolOwner.length === 0 ? 'ok' : 'warn',
        detail:
            auditBefore.missingPoolOwner.length === 0
                ? 'Tous les liens pool attendus sont OK'
                : `${auditBefore.missingPoolOwner.length} sans lien pool_owner OK`
    });
    checks.push({
        id: 'audit_mirror_errors_before',
        label: 'Audit — liens en statut d’erreur (avant réparation)',
        description: 'Lignes planning_event_google_mirror avec sync_status ≠ ok.',
        status: auditBefore.mirrorErrors.length === 0 ? 'ok' : 'warn',
        detail:
            auditBefore.mirrorErrors.length === 0
                ? 'Aucun lien en erreur'
                : `${auditBefore.mirrorErrors.length} lien(s) en erreur`
    });

    bodySections.push(`<h3>3. Audit miroirs Google (état initial, ${AUDIT_HORIZON_DAYS} jours à venir)</h3>`);
    bodySections.push(
        `<p>Créneaux analysés en base : <strong>${futureEvents.length}</strong> (max ${MAX_EVENTS_SCAN}).</p>`
    );
    bodySections.push(
        `<p>Résumé initial : sans lien <strong>principal</strong> OK : <strong>${auditBefore.missingMain.length}</strong> — sans lien <strong>agenda perso (pool)</strong> : <strong>${auditBefore.missingPoolOwner.length}</strong> — liens en <strong>erreur</strong> : <strong>${auditBefore.mirrorErrors.length}</strong> — agendas en écart : <strong>${bucketsBefore.length}</strong>.</p>`
    );
    bodySections.push('<h4>Détail par agenda</h4>');
    bodySections.push(
        renderAuditByCalendar(
            bucketsBefore,
            'Aucune anomalie sur les agendas suivis (principal + pools assignés).'
        )
    );

    /* ——— Réparation automatique ——— */
    let repairResult: Record<string, unknown> = { skipped: true };
    if (anonKey && cronSecret) {
        repairResult = await runGoogleRepair(supabaseUrl, cronSecret, anonKey);
    }

    if (repairResult.skipped) {
        checks.push({
            id: 'google_repair',
            label: 'Réparation Google (cron_repair_google_sync)',
            description: 'Création / réalignement des liens puis resync des agendas concernés.',
            status: 'skip',
            detail: 'Non lancée : SUPABASE_ANON_KEY ou secret cron manquant'
        });
    } else if (repairResult.ok === false) {
        const rErrs = repairResult.errors;
        const errN = Array.isArray(rErrs) ? rErrs.length : 0;
        checks.push({
            id: 'google_repair',
            label: 'Réparation Google (cron_repair_google_sync)',
            description: 'Création / réalignement des liens puis resync des agendas concernés.',
            status: 'error',
            detail: `Terminée avec erreurs — principal ${repairResult.repairedMain ?? 0}, pool ${repairResult.repairedPool ?? 0}, resync ${repairResult.resyncedCalendars ?? 0}${errN ? `, ${errN} message(s) d’erreur` : ''}`
        });
    } else {
        checks.push({
            id: 'google_repair',
            label: 'Réparation Google (cron_repair_google_sync)',
            description: 'Création / réalignement des liens puis resync des agendas concernés.',
            status: 'ok',
            detail: `Principal ${repairResult.repairedMain ?? 0}, pool ${repairResult.repairedPool ?? 0}, ${repairResult.resyncedCalendars ?? 0} agenda(s) resynchronisé(s)`
        });
    }

    bodySections.push('<h3>4. Réparation automatique Google (<code>cron_repair_google_sync</code>)</h3>');
    if (repairResult.skipped) {
        bodySections.push('<p>Non lancée (configuration cron incomplète).</p>');
    } else {
        bodySections.push(
            `<p>Liens principal créés ou réalignés : <strong>${escapeHtml(String(repairResult.repairedMain ?? 0))}</strong> — liens pool : <strong>${escapeHtml(String(repairResult.repairedPool ?? 0))}</strong> — agendas resynchronisés : <strong>${escapeHtml(String(repairResult.resyncedCalendars ?? 0))}</strong> — statut global : <strong>${repairResult.ok === false ? 'erreurs' : 'OK'}</strong>.</p>`
        );
        bodySections.push('<h4>Agendas resynchronisés (par nom Planning IAMS et utilisateur)</h4>');
        bodySections.push(renderResyncedCalendars(repairResult));
        const rErrs = repairResult.errors;
        if (Array.isArray(rErrs) && rErrs.length) {
            bodySections.push('<p>Détail des erreurs de réparation :</p><ul>');
            for (const err of rErrs) {
                bodySections.push(`<li>${escapeHtml(String(err))}</li>`);
            }
            bodySections.push('</ul>');
        }
    }

    /* ——— Audit APRÈS réparation ——— */
    const eventsAfter = await loadFutureEvents(admin, nowIso, horizonIso);
    const auditAfter = await auditMirrors(admin, eventsAfter, poolUserIds);
    const bucketsAfter = buildAuditBuckets(auditAfter, calendarDirectory);
    const hasAnomalies =
        auditAfter.missingMain.length > 0 ||
        auditAfter.missingPoolOwner.length > 0 ||
        auditAfter.mirrorErrors.length > 0;

    checks.push({
        id: 'audit_final_main',
        label: 'Contrôle final — agenda principal',
        description: 'Vérification après réparation (référence pour le prochain run).',
        status: auditAfter.missingMain.length === 0 ? 'ok' : 'error',
        detail:
            auditAfter.missingMain.length === 0
                ? 'Aligné'
                : `${auditAfter.missingMain.length} créneau(x) encore sans lien principal OK`
    });
    checks.push({
        id: 'audit_final_pool',
        label: 'Contrôle final — agendas pool',
        description: 'Vérification après réparation.',
        status: auditAfter.missingPoolOwner.length === 0 ? 'ok' : 'error',
        detail:
            auditAfter.missingPoolOwner.length === 0
                ? 'Aligné'
                : `${auditAfter.missingPoolOwner.length} créneau(x) encore sans lien pool OK`
    });
    checks.push({
        id: 'audit_final_errors',
        label: 'Contrôle final — liens en erreur',
        description: 'Si échec ici, une entrée sera ajoutée au journal infra.',
        status: auditAfter.mirrorErrors.length === 0 ? 'ok' : 'error',
        detail:
            auditAfter.mirrorErrors.length === 0
                ? 'Aucun lien en erreur'
                : `${auditAfter.mirrorErrors.length} lien(s) encore en erreur`
    });

    bodySections.push('<h3>5. Contrôle final (après réparation)</h3>');
    if (!hasAnomalies) {
        bodySections.push(
            '<p><strong>Aucune anomalie détectée.</strong> Tous les créneaux concernés sont alignés avec Google (base → agendas).</p>'
        );
    } else {
        bodySections.push(
            `<p><strong>Anomalies restantes</strong> — sans lien principal : <strong>${auditAfter.missingMain.length}</strong> — sans lien agenda perso : <strong>${auditAfter.missingPoolOwner.length}</strong> — liens en erreur : <strong>${auditAfter.mirrorErrors.length}</strong> — agendas encore en écart : <strong>${bucketsAfter.length}</strong>.</p>`
        );
        bodySections.push('<h4>Détail par agenda</h4>');
        bodySections.push(renderAuditByCalendar(bucketsAfter, 'Aucune anomalie restante.'));
    }

    const globalOk = checks.every((c) => c.status === 'ok' || c.status === 'skip');
    checks.push({
        id: 'job_execution',
        label: 'Exécution fonction planning-nightly',
        description: 'Le job a atteint la fin des traitements (hors envoi e-mail).',
        status: globalOk && !hasAnomalies ? 'ok' : hasAnomalies ? 'warn' : 'warn',
        detail: globalOk
            ? hasAnomalies
                ? 'Terminé — anomalies agendas restantes (voir section 5)'
                : 'Terminé sans anomalie agenda'
            : 'Terminé avec au moins un contrôle en échec'
    });

    bodySections.push('<h3>6. Synthèse</h3>');
    bodySections.push(
        `<p>Ordre des traitements : digest journal → audit initial → réparation Google → contrôle final. Le prochain digest ne listera une nouvelle alerte infra que si le <strong>contrôle final</strong> trouve encore des écarts.</p>`
    );
    bodySections.push(
        '<p><strong>Périmètre :</strong> workflow GitHub <strong>Planning nightly report</strong> uniquement (pas <code>supabase-keepalive</code> ni les autres crons).</p>'
    );

    checks.push({
        id: 'email_send',
        label: 'Envoi du rapport par e-mail (Brevo)',
        description: `API Brevo → ${notifyEmail}. La réception de ce message confirme la remise.`,
        status: brevoKey && fromEmail ? 'ok' : 'error',
        detail:
            brevoKey && fromEmail
                ? 'Configuration présente — envoi tenté en fin de job'
                : 'Impossible d’envoyer (voir contrôle Brevo ci-dessus)'
    });

    const lines: string[] = [
        bodySections[0],
        bodySections[1],
        '<h3>1. Synthèse des contrôles (job nocturne)</h3>',
        '<p>Tableau récapitulatif de chaque vérification exécutée ce run. Les sections 2 à 6 détaillent les écarts éventuels.</p>',
        renderControlsTable(checks),
        ...bodySections.slice(2)
    ];

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/></head><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222;">${lines.join('\n')}</body></html>`;

    const sent = await sendBrevoHtml(
        notifyEmail,
        `[Planning IAMS] Rapport nocturne ${nowIso.slice(0, 10)}`,
        html
    );

    if (!sent.ok) {
        const emailCheck = checks.find((c) => c.id === 'email_send');
        if (emailCheck) {
            emailCheck.status = 'error';
            emailCheck.detail =
                'detail' in sent ? String(sent.detail || sent.error) : String(sent.error);
        }
        return json(
            {
                ok: false,
                error: sent.error,
                detail: 'detail' in sent ? sent.detail : undefined,
                controls: checks
            },
            502
        );
    }

    const errIds = (pendingErrors ?? []).map((r) => r.id).filter(Boolean);
    if (errIds.length) {
        await admin
            .from('planning_infra_error_log')
            .update({ digest_sent_at: nowIso })
            .in('id', errIds);
    }

    if (hasAnomalies) {
        await admin.from('planning_infra_error_log').insert({
            source: 'nightly_calendar_audit',
            message: `Après réparation : ${auditAfter.missingMain.length} sans miroir principal ; ${auditAfter.missingPoolOwner.length} sans miroir agenda perso ; ${auditAfter.mirrorErrors.length} miroir(s) en erreur`,
            detail: {
                missing_main_count: auditAfter.missingMain.length,
                missing_pool_owner_count: auditAfter.missingPoolOwner.length,
                mirror_error_count: auditAfter.mirrorErrors.length,
                repair: repairResult,
                audit_before: {
                    missing_main: auditBefore.missingMain.length,
                    missing_pool_owner: auditBefore.missingPoolOwner.length,
                    mirror_errors: auditBefore.mirrorErrors.length
                },
                checked_at: nowIso
            }
        });
    }

    return json({
        ok: true,
        emailSent: true,
        notifyEmail,
        mode: 'nightly',
        controls: checks.map((c) => ({
            id: c.id,
            label: c.label,
            status: c.status,
            detail: c.detail ?? null
        })),
        pendingErrorsDigested: errIds.length,
        auditBefore: {
            missingMain: auditBefore.missingMain.length,
            missingPoolOwner: auditBefore.missingPoolOwner.length,
            mirrorErrors: auditBefore.mirrorErrors.length
        },
        auditAfter: {
            missingMain: auditAfter.missingMain.length,
            missingPoolOwner: auditAfter.missingPoolOwner.length,
            mirrorErrors: auditAfter.mirrorErrors.length
        },
        hasAnomalies,
        repair: repairResult
    });
});
