/**
 * Notification par e-mail (Brevo) : un utilisateur A a modifié / déplacé / supprimé
 * un créneau appartenant à B → e-mail à B. L’appelant doit être A (JWT = actorEmail).
 *
 * Secrets :
 *   BREVO_API_KEY — clé API SMTP & API (Brevo)
 *   NOTIFY_FROM_EMAIL — expéditeur vérifié chez Brevo
 *   NOTIFY_FROM_NAME — optionnel (défaut : Planning Orgue IAMS)
 *
 * Déploiement : supabase functions deploy planning-slot-notify
 */

import { fetchAuthUser } from '../_shared/auth_gotrue.ts';

const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-version'
};

type SlotAction = 'deleted' | 'moved' | 'modified';

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

function formatFrWhen(startIso: string, endIso: string) {
    try {
        const a = new Date(startIso);
        const b = new Date(endIso);
        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${startIso} → ${endIso}`;
        const opts: Intl.DateTimeFormatOptions = {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        };
        return `${a.toLocaleString('fr-FR', opts)} — ${b.toLocaleString('fr-FR', opts)}`;
    } catch {
        return `${startIso} → ${endIso}`;
    }
}

function actionLabelFr(action: SlotAction): string {
    switch (action) {
        case 'deleted':
            return 'supprimé';
        case 'moved':
            return 'déplacé';
        default:
            return 'modifié';
    }
}

function normalizeSecretValue(v: string | undefined): string {
    const raw = String(v ?? '').trim();
    if (!raw) return '';
    const unquoted =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
            ? raw.slice(1, -1).trim()
            : raw;
    return unquoted.replace(/\r?\n/g, '').trim();
}

function normalizeBrevoApiKey(v: string | undefined): string {
    let s = normalizeSecretValue(v);
    if (!s) return '';
    s = s.replace(/^api-key\s*:\s*/i, '').trim();
    s = s.replace(/^bearer\s+/i, '').trim();
    return s;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

    if (req.method !== 'POST') {
        return json({ ok: false, emailSent: false, error: 'Method not allowed' }, 405);
    }

    try {
        const authHeader = req.headers.get('Authorization');
        const jwt = authHeader?.replace(/^Bearer\s+/i, '').trim();
        if (!jwt) return json({ ok: false, emailSent: false, error: 'Missing Authorization' }, 401);

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

        const { user, error: authErr } = await fetchAuthUser(supabaseUrl, supabaseAnonKey, jwt);
        if (authErr || !user?.email) {
            return json({ ok: false, emailSent: false, error: authErr || 'Unauthorized' }, 401);
        }

        const me = user.email.trim().toLowerCase();

        let body: Record<string, unknown>;
        try {
            body = (await req.json()) as Record<string, unknown>;
        } catch {
            return json({ ok: false, emailSent: false, error: 'JSON invalide' }, 400);
        }

        const targetEmail = String(body.targetEmail ?? '')
            .trim()
            .toLowerCase();
        const actorEmail = String(body.actorEmail ?? '')
            .trim()
            .toLowerCase();
        const action = String(body.action ?? '') as SlotAction;

        if (!targetEmail || !actorEmail || !['deleted', 'moved', 'modified'].includes(action)) {
            return json({ ok: false, emailSent: false, error: 'Requête invalide' }, 400);
        }

        if (actorEmail !== me) {
            return json({ ok: false, emailSent: false, error: 'Forbidden' }, 403);
        }

        if (targetEmail === actorEmail) {
            return json({ ok: true, emailSent: false, skipped: true }, 200);
        }

        const apiKey = normalizeBrevoApiKey(Deno.env.get('BREVO_API_KEY'));
        const fromEmail = normalizeSecretValue(Deno.env.get('NOTIFY_FROM_EMAIL'));
        const fromName = (Deno.env.get('NOTIFY_FROM_NAME') ?? 'Planning Orgue IAMS').trim();

        if (!apiKey || !fromEmail) {
            return json({
                ok: false,
                emailSent: false,
                error: 'EMAIL_NOT_CONFIGURED',
                detail: 'Secrets BREVO_API_KEY et NOTIFY_FROM_EMAIL requis'
            });
        }

        const actorDisplayName = String(body.actorDisplayName ?? '').trim() || actorEmail;
        const slotTitle = String(body.slotTitle ?? 'Créneau').trim() || 'Créneau';
        const slotStartIso = String(body.slotStartIso ?? '');
        const slotEndIso = String(body.slotEndIso ?? '');
        const previousStartIso = String(body.previousStartIso ?? '');
        const previousEndIso = String(body.previousEndIso ?? '');

        const verbe = actionLabelFr(action);
        const subject = `Planning orgue — votre créneau a été ${verbe}`;

        let detailHtml = '';
        if (action === 'deleted') {
            detailHtml = `<p>Créneau concerné : <strong>${escapeHtml(slotTitle)}</strong></p>
<p>Période : ${escapeHtml(formatFrWhen(slotStartIso, slotEndIso))}</p>`;
        } else if (action === 'moved' && previousStartIso && previousEndIso) {
            detailHtml = `<p>Créneau : <strong>${escapeHtml(slotTitle)}</strong></p>
<p>Ancienne plage : ${escapeHtml(formatFrWhen(previousStartIso, previousEndIso))}</p>
<p>Nouvelle plage : ${escapeHtml(formatFrWhen(slotStartIso, slotEndIso))}</p>`;
        } else {
            detailHtml = `<p>Créneau : <strong>${escapeHtml(slotTitle)}</strong></p>
<p>Plage actuelle : ${escapeHtml(formatFrWhen(slotStartIso, slotEndIso))}</p>`;
            if (previousStartIso && previousEndIso) {
                detailHtml += `<p>Ancienne plage : ${escapeHtml(formatFrWhen(previousStartIso, previousEndIso))}</p>`;
            }
        }

        const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/></head><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222;">
<p>Bonjour,</p>
<p><strong>${escapeHtml(actorDisplayName)}</strong> (${escapeHtml(actorEmail)}) a <strong>${escapeHtml(verbe)}</strong> un de vos créneaux sur le planning orgue IAMS.</p>
${detailHtml}
<p>Ce message est automatique ; en cas de question, vous pouvez répondre directement à cette personne.</p>
</body></html>`;

        const brevoBody = {
            sender: { name: fromName, email: fromEmail },
            to: [{ email: targetEmail }],
            subject,
            htmlContent: html
        };

        const authAttempts: Array<{ mode: string; headers: Record<string, string> }> = [
            {
                mode: 'all-headers',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    'api-key': apiKey,
                    'Api-Key': apiKey,
                    apikey: apiKey,
                    Authorization: `Bearer ${apiKey}`,
                    'partner-key': apiKey
                }
            },
            {
                mode: 'authorization-bearer',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                }
            },
            {
                mode: 'partner-key',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    'partner-key': apiKey
                }
            }
        ];

        let brevoRes: Response | null = null;
        let lastAuthDetail = '';
        let authModeUsed = '';
        const attemptDetails: string[] = [];
        for (const attempt of authAttempts) {
            const res = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: attempt.headers,
                body: JSON.stringify(brevoBody)
            });
            authModeUsed = attempt.mode;
            if (res.ok) {
                brevoRes = res;
                break;
            }
            const raw = await res.text();
            lastAuthDetail = `[${attempt.mode}] ${raw.slice(0, 300)}`;
            attemptDetails.push(lastAuthDetail);
            if (res.status !== 401) {
                return json({
                    ok: false,
                    emailSent: false,
                    error: 'BREVO_SEND_FAILED',
                    detail: lastAuthDetail
                });
            }
        }
        if (!brevoRes) {
            return json({
                ok: false,
                emailSent: false,
                error: 'BREVO_SEND_FAILED',
                detail:
                    attemptDetails.join(' | ').slice(0, 800) ||
                    lastAuthDetail ||
                    'Aucune méthode d’auth Brevo acceptée.'
            });
        }

        if (!brevoRes.ok) {
            const t = await brevoRes.text();
            return json({
                ok: false,
                emailSent: false,
                error: 'BREVO_SEND_FAILED',
                detail: `[${authModeUsed}] ${t.slice(0, 350)}`
            });
        }

        return json({ ok: true, emailSent: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, emailSent: false, error: msg }, 500);
    }
});
