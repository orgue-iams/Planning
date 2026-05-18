/**
 * Rapport nocturne (cron) : santé, digest erreurs infra, audit miroirs Google.
 * Auth : Authorization: Bearer <PLANNING_CRON_SECRET> (secret Edge, pas JWT utilisateur).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret'
};

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
    if (!supabaseUrl || !serviceKey) {
        return json({ ok: false, error: 'Missing service configuration' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: settings } = await admin
        .from('organ_school_settings')
        .select('planning_error_notify_email')
        .limit(1)
        .maybeSingle();
    const notifyEmail = String(settings?.planning_error_notify_email ?? '')
        .trim()
        .toLowerCase();
    if (!notifyEmail) {
        return json({ ok: false, error: 'planning_error_notify_email non configuré' }, 400);
    }

    const nowIso = new Date().toISOString();
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 30);

    const { data: pendingErrors } = await admin
        .from('planning_infra_error_log')
        .select('id, occurred_at, source, message')
        .is('digest_sent_at', null)
        .order('occurred_at', { ascending: true })
        .limit(50);

    const { data: futureEvents } = await admin
        .from('planning_event')
        .select('id, start_at, end_at, title, slot_type, owner_email')
        .gte('start_at', nowIso)
        .lte('start_at', horizon.toISOString())
        .order('start_at', { ascending: true })
        .limit(500);

    const eventIds = (futureEvents ?? []).map((e) => e.id);
    let mirrors: Array<{ event_id: string; target: string; sync_status: string; last_error: string | null }> =
        [];
    if (eventIds.length) {
        const { data: mir } = await admin
            .from('planning_event_google_mirror')
            .select('event_id, target, sync_status, last_error')
            .in('event_id', eventIds);
        mirrors = mir ?? [];
    }

    const mainOk = new Set(
        mirrors
            .filter((m) => m.target === 'main' && m.sync_status === 'ok')
            .map((m) => m.event_id)
    );
    const mirrorErrors = mirrors.filter((m) => m.sync_status && m.sync_status !== 'ok');
    const missingMain = (futureEvents ?? []).filter(
        (e) => String(e.slot_type || '').toLowerCase() !== 'fermeture' && !mainOk.has(e.id)
    );

    const lines: string[] = [];
    lines.push(`<p>Rapport automatique Planning IAMS — ${escapeHtml(nowIso)}</p>`);
    lines.push('<h3>Santé</h3><p>Contrôle exécuté avec succès.</p>');

    lines.push(`<h3>Erreurs infra en attente (${(pendingErrors ?? []).length})</h3>`);
    if (!(pendingErrors ?? []).length) {
        lines.push('<p>Aucune entrée en attente dans <code>planning_infra_error_log</code>.</p>');
    } else {
        lines.push('<ul>');
        for (const row of pendingErrors ?? []) {
            lines.push(
                `<li><strong>${escapeHtml(String(row.source))}</strong> — ${escapeHtml(String(row.message))} <em>(${escapeHtml(String(row.occurred_at))})</em></li>`
            );
        }
        lines.push('</ul>');
    }

    lines.push(`<h3>Audit miroirs Google (30 jours)</h3>`);
    lines.push(
        `<p>Créneaux sans miroir principal OK : <strong>${missingMain.length}</strong> — miroirs en erreur : <strong>${mirrorErrors.length}</strong>.</p>`
    );
    if (missingMain.length) {
        lines.push('<p>Exemples sans miroir principal :</p><ul>');
        for (const ev of missingMain.slice(0, 15)) {
            lines.push(
                `<li>${escapeHtml(String(ev.title || ''))} — ${escapeHtml(String(ev.start_at))} (${escapeHtml(String(ev.owner_email || ''))})</li>`
            );
        }
        lines.push('</ul>');
    }
    if (mirrorErrors.length) {
        lines.push('<p>Miroirs en échec (extrait) :</p><ul>');
        for (const m of mirrorErrors.slice(0, 15)) {
            lines.push(
                `<li>${escapeHtml(m.event_id)} / ${escapeHtml(m.target)} — ${escapeHtml(String(m.sync_status))} ${escapeHtml(String(m.last_error || ''))}</li>`
            );
        }
        lines.push('</ul>');
    }

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/></head><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222;">${lines.join('\n')}</body></html>`;

    const apiKey = normalizeBrevoApiKey(Deno.env.get('BREVO_API_KEY'));
    const fromEmail = String(Deno.env.get('NOTIFY_FROM_EMAIL') ?? '').trim();
    const fromName = String(Deno.env.get('NOTIFY_FROM_NAME') ?? 'Planning Orgue IAMS').trim();
    if (!apiKey || !fromEmail) {
        return json({ ok: false, error: 'BREVO_API_KEY ou NOTIFY_FROM_EMAIL manquant' }, 500);
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
            subject: `[Planning IAMS] Rapport nocturne ${nowIso.slice(0, 10)}`,
            htmlContent: html
        })
    });

    if (!brevoRes.ok) {
        const t = await brevoRes.text();
        return json({ ok: false, error: 'BREVO_SEND_FAILED', detail: t.slice(0, 350) }, 502);
    }

    const errIds = (pendingErrors ?? []).map((r) => r.id).filter(Boolean);
    if (errIds.length) {
        await admin
            .from('planning_infra_error_log')
            .update({ digest_sent_at: nowIso })
            .in('id', errIds);
    }

    if (missingMain.length || mirrorErrors.length) {
        await admin.from('planning_infra_error_log').insert({
            source: 'nightly_calendar_audit',
            message: `${missingMain.length} créneau(x) sans miroir principal OK ; ${mirrorErrors.length} miroir(s) en erreur`,
            detail: {
                missing_main_count: missingMain.length,
                mirror_error_count: mirrorErrors.length,
                checked_at: nowIso
            }
        });
    }

    return json({
        ok: true,
        emailSent: true,
        notifyEmail,
        pendingErrors: errIds.length,
        missingMain: missingMain.length,
        mirrorErrors: mirrorErrors.length
    });
});
