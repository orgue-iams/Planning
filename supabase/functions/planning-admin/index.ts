/**
 * Gestion des comptes (secrétaire = role admin dans profiles).
 * Secrets auto : SUPABASE_URL, SUPABASE_ANON_KEY ; service role : SERVICE_ROLE_KEY (Edge) ou SUPABASE_SERVICE_ROLE_KEY (local)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { fetchAuthUser } from '../_shared/auth_gotrue.ts';
import { normalizeGoogleCalendarId } from '../_shared/normalize_google_calendar_id.ts';

const MIN_PASSWORD_LEN = 6;

/** Aligné sur public.profiles.role (check SQL). */
const PLANNING_ROLES = ['admin', 'prof', 'eleve'] as const;

function isPlanningRole(r: string): boolean {
    return (PLANNING_ROLES as readonly string[]).includes(r.toLowerCase());
}

function normalizePlanningRole(r: string): (typeof PLANNING_ROLES)[number] {
    const x = r.toLowerCase();
    return isPlanningRole(x) ? (x as (typeof PLANNING_ROLES)[number]) : 'eleve';
}

function planningFullName(nom: string, prenom: string): string {
    const n = nom.trim();
    const p = prenom.trim();
    if (n && p) return `${p} ${n}`;
    return p || n || '';
}

/** Corps JSON : champs nom + prénom ; repli sur display_name seul (anciens clients). */
function readNomPrenom(body: Record<string, unknown>): { nom: string; prenom: string } {
    let nom = String(body.nom ?? '').trim();
    let prenom = String(body.prenom ?? '').trim();
    if (!nom && !prenom) {
        const leg = String(body.display_name ?? '').trim();
        if (leg) nom = leg;
    }
    return { nom, prenom };
}

function sortUsersForAdminList<
    T extends { nom?: string | null; prenom?: string | null; email?: string | null }
>(users: T[]): T[] {
    return [...users].sort((a, b) => {
        const an = String(a.nom ?? '').trim().toLowerCase();
        const bn = String(b.nom ?? '').trim().toLowerCase();
        if (an !== bn) return an.localeCompare(bn, 'fr');
        const ap = String(a.prenom ?? '').trim().toLowerCase();
        const bp = String(b.prenom ?? '').trim().toLowerCase();
        if (ap !== bp) return ap.localeCompare(bp, 'fr');
        return String(a.email ?? '')
            .toLowerCase()
            .localeCompare(String(b.email ?? '').toLowerCase(), 'fr');
    });
}

/** Évite les URLs `in.(id)` trop longues (liste vide / erreur silencieuse côté client). */
async function profileRowsForUserIds(
    admin: ReturnType<typeof createClient>,
    ids: string[]
): Promise<
    Map<
        string,
        {
            id: string;
            nom: string;
            prenom: string;
            display_name: string | null;
            role: string;
            telephone: string;
            directory_share_email: boolean;
            directory_share_phone: boolean;
            calendar_assignment_error: string | null;
            personal_google_calendar_id: string | null;
            personal_calendar_label: string | null;
        }
    >
> {
    const map = new Map<
        string,
        {
            id: string;
            nom: string;
            prenom: string;
            display_name: string | null;
            role: string;
            telephone: string;
            directory_share_email: boolean;
            directory_share_phone: boolean;
            calendar_assignment_error: string | null;
            personal_google_calendar_id: string | null;
            personal_calendar_label: string | null;
        }
    >();
    const chunk = 40;
    for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const { data, error } = await admin
            .from('profiles')
            .select(
                'id,nom,prenom,display_name,role,telephone,directory_share_email,directory_share_phone,calendar_assignment_error'
            )
            .in('id', slice);
        if (error) throw error;
        const { data: poolRows, error: poolErr } = await admin
            .from('google_calendar_pool')
            .select('assigned_user_id,google_calendar_id,label')
            .in('assigned_user_id', slice);
        if (poolErr) throw poolErr;
        const calByUser = new Map<string, string>();
        const labelByUser = new Map<string, string | null>();
        for (const pr of poolRows ?? []) {
            const uid = (pr as { assigned_user_id: string | null }).assigned_user_id;
            const gid = (pr as { google_calendar_id: string }).google_calendar_id;
            const lab = (pr as { label: string | null }).label;
            if (uid) {
                calByUser.set(uid, gid);
                labelByUser.set(uid, lab ?? null);
            }
        }
        for (const p of data ?? []) {
            const row = p as {
                id: string;
                nom: string | null;
                prenom: string | null;
                display_name: string | null;
                role: string;
                telephone: string | null;
                directory_share_email: boolean | null;
                directory_share_phone: boolean | null;
                calendar_assignment_error: string | null;
            };
            map.set(row.id, {
                id: row.id,
                nom: String(row.nom ?? '').trim(),
                prenom: String(row.prenom ?? '').trim(),
                display_name: row.display_name,
                role: row.role,
                telephone: String(row.telephone ?? '').trim(),
                directory_share_email: row.directory_share_email !== false,
                directory_share_phone: row.directory_share_phone === true,
                calendar_assignment_error: row.calendar_assignment_error ?? null,
                personal_google_calendar_id: calByUser.get(row.id) ?? null,
                personal_calendar_label: labelByUser.get(row.id) ?? null
            });
        }
    }
    return map;
}

type ListedUser = {
    id: string;
    email?: string | null;
    banned_until?: string | null;
    created_at?: string | null;
};

/** Message lisible pour l’admin GoTrue / liste utilisateurs (évite un toast JSON brut). */
function formatAuthListUsersError(err: unknown): string {
    let m = '';
    if (typeof err === 'string') {
        m = err.trim();
    } else if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
        m = (err as { message: string }).message.trim();
    }
    if (!m) return 'Impossible de lister les comptes (erreur Auth serveur).';
    if (/database error finding users/i.test(m)) {
        return (
            `${m} — Côté projet Supabase : vérifier l’onglet Auth / SQL ; une table public.users ou un search_path peut perturber GoTrue. ` +
            `Si besoin : Dashboard → SQL → pas de table public.users en conflit ; migrations auth à jour.`
        );
    }
    return m;
}

const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-version'
};

type GateOk = { user: { id: string; email?: string } };
type GateErr = { error: string };
async function requirePlanningAdmin(authHeader: string | null, anonKey: string, url: string): Promise<GateOk | GateErr> {
    if (!authHeader) return { error: 'Missing Authorization' };
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return { error: 'Missing Authorization' };
    const { user, error: authErr } = await fetchAuthUser(url, anonKey, jwt);
    if (authErr || !user) {
        return { error: authErr?.trim() || 'Unauthorized' };
    }
    const userClient = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${jwt}` } }
    });
    const { data: row } = await userClient.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (row?.role !== 'admin') return { error: 'Forbidden: planning admin only' };
    return { user: { id: user.id, email: user.email } };
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...cors, 'Content-Type': 'application/json' }
        });
    }

    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const serviceKey =
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
    if (!url || !anonKey || !serviceKey) {
        return new Response(
            JSON.stringify({
                error: 'Configuration serveur incomplète (SUPABASE_URL, SUPABASE_ANON_KEY ou SERVICE_ROLE manquant).'
            }),
            {
                status: 500,
                headers: { ...cors, 'Content-Type': 'application/json' }
            }
        );
    }

    const authHeader = req.headers.get('Authorization');
    const gate = await requirePlanningAdmin(authHeader, anonKey, url);
    if ('error' in gate) {
        return new Response(JSON.stringify({ error: gate.error }), {
            status: gate.error.startsWith('Forbidden') ? 403 : 401,
            headers: { ...cors, 'Content-Type': 'application/json' }
        });
    }
    const caller = gate.user;

    const admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' }
        });
    }

    const action = String(body.action ?? '');

    try {
        if (action === 'list_users') {
            type RpcRow = {
                id: string;
                email?: string | null;
                created_at?: string | null;
                banned_until?: string | null;
                nom?: string | null;
                prenom?: string | null;
                display_name?: string | null;
                profile_role?: string | null;
                telephone?: string | null;
                directory_share_email?: boolean | null;
                directory_share_phone?: boolean | null;
                calendar_assignment_error?: string | null;
                personal_google_calendar_id?: string | null;
                personal_calendar_label?: string | null;
            };

            const { data: rpcRaw, error: rpcErr } = await admin.rpc('planning_admin_list_auth_users');
            if (rpcErr) {
                /* Fallback si la migration 005 n’est pas encore appliquée. */
                const perPage = 200;
                let page = 1;
                const all: Array<{
                    id: string;
                    email: string;
                    nom: string;
                    prenom: string;
                    display_name: string | null;
                    role: string;
                    telephone: string;
                    directory_share_email: boolean;
                    directory_share_phone: boolean;
                    banned_until: string | null;
                    created_at: string | null;
                    calendar_assignment_error: string | null;
                    personal_google_calendar_id: string | null;
                    personal_calendar_label: string | null;
                }> = [];

                while (true) {
                    const { data: pageData, error: listErr } = await admin.auth.admin.listUsers({ page, perPage });
                    if (listErr) {
                        throw new Error(formatAuthListUsersError(listErr));
                    }
                    const users = (pageData?.users ?? []) as ListedUser[];
                    if (users.length === 0) break;

                    const ids = users.map((u) => u.id).filter(Boolean);
                    const pmap = await profileRowsForUserIds(admin, ids);

                    for (const u of users) {
                        if (!u?.id) continue;
                        const p = pmap.get(u.id);
                        const ban = u.banned_until ?? null;
                        const dbRole = p?.role != null ? String(p.role) : '';
                        all.push({
                            id: u.id,
                            email: u.email ?? '',
                            nom: p?.nom ?? '',
                            prenom: p?.prenom ?? '',
                            display_name: p?.display_name ?? null,
                            role: normalizePlanningRole(dbRole),
                            telephone: p?.telephone ?? '',
                            directory_share_email: p?.directory_share_email !== false,
                            directory_share_phone: p?.directory_share_phone === true,
                            banned_until: ban ?? null,
                            created_at: u.created_at ?? null,
                            calendar_assignment_error: p?.calendar_assignment_error ?? null,
                            personal_google_calendar_id: p?.personal_google_calendar_id ?? null,
                            personal_calendar_label: p?.personal_calendar_label ?? null
                        });
                    }
                    if (users.length < perPage) break;
                    page++;
                }

                return new Response(JSON.stringify({ ok: true, users: sortUsersForAdminList(all) }), {
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }

            let parsed: unknown = rpcRaw;
            if (typeof rpcRaw === 'string') {
                try {
                    parsed = JSON.parse(rpcRaw);
                } catch {
                    parsed = [];
                }
            }
            const rows = Array.isArray(parsed) ? (parsed as RpcRow[]) : [];
            const all = rows.map((row) => {
                const dbRole = row.profile_role != null ? String(row.profile_role) : '';
                return {
                    id: String(row.id ?? ''),
                    email: String(row.email ?? ''),
                    nom: row.nom != null ? String(row.nom) : '',
                    prenom: row.prenom != null ? String(row.prenom) : '',
                    display_name: row.display_name != null ? String(row.display_name) : null,
                    role: normalizePlanningRole(dbRole),
                    telephone: row.telephone != null ? String(row.telephone) : '',
                    directory_share_email: row.directory_share_email !== false,
                    directory_share_phone: row.directory_share_phone === true,
                    banned_until: row.banned_until != null ? String(row.banned_until) : null,
                    created_at: row.created_at != null ? String(row.created_at) : null,
                    calendar_assignment_error:
                        row.calendar_assignment_error != null ? String(row.calendar_assignment_error) : null,
                    personal_google_calendar_id:
                        row.personal_google_calendar_id != null ? String(row.personal_google_calendar_id) : null,
                    personal_calendar_label:
                        row.personal_calendar_label != null ? String(row.personal_calendar_label) : null
                };
            });

            return new Response(JSON.stringify({ ok: true, users: sortUsersForAdminList(all) }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'invite') {
            const email = String(body.email ?? '')
                .trim()
                .toLowerCase();
            const { nom, prenom } = readNomPrenom(body);
            const fullName = planningFullName(nom, prenom);
            const role = String(body.role ?? 'eleve').toLowerCase();
            const redirectTo = String(body.redirect_to ?? '').trim();

            if (!email.includes('@')) {
                return new Response(JSON.stringify({ error: 'Email invalide' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!fullName) {
                return new Response(JSON.stringify({ error: 'Le nom et le prénom sont obligatoires.' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!isPlanningRole(role)) {
                return new Response(
                    JSON.stringify({ error: 'Rôle invalide : admin, prof ou eleve uniquement.' }),
                    {
                        status: 400,
                        headers: { ...cors, 'Content-Type': 'application/json' }
                    }
                );
            }
            if (!redirectTo.startsWith('http')) {
                return new Response(JSON.stringify({ error: 'redirect_to requis (URL du site)' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }

            const telInvite = String(body.telephone ?? '')
                .trim()
                .slice(0, 40);
            const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
                redirectTo,
                data: {
                    nom,
                    prenom,
                    telephone: telInvite,
                    display_name: fullName,
                    role: normalizePlanningRole(role)
                }
            });
            if (error) throw error;

            return new Response(JSON.stringify({ ok: true, user: data.user }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'create_user') {
            const email = String(body.email ?? '').trim().toLowerCase();
            const { nom, prenom } = readNomPrenom(body);
            const fullName = planningFullName(nom, prenom);
            const role = String(body.role ?? 'eleve').toLowerCase();
            const password = String(body.password ?? '');

            if (!email.includes('@')) {
                return new Response(JSON.stringify({ error: 'Email invalide' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!fullName) {
                return new Response(JSON.stringify({ error: 'Le nom et le prénom sont obligatoires.' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!isPlanningRole(role)) {
                return new Response(
                    JSON.stringify({ error: 'Rôle invalide : admin, prof ou eleve uniquement.' }),
                    {
                        status: 400,
                        headers: { ...cors, 'Content-Type': 'application/json' }
                    }
                );
            }
            if (password.length < MIN_PASSWORD_LEN) {
                return new Response(
                    JSON.stringify({ error: `Mot de passe : au moins ${MIN_PASSWORD_LEN} caractères` }),
                    { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
                );
            }

            const nr = normalizePlanningRole(role);
            const telCreate = String(body.telephone ?? '')
                .trim()
                .slice(0, 40);
            const { data, error } = await admin.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                user_metadata: {
                    nom,
                    prenom,
                    telephone: telCreate,
                    display_name: fullName,
                    role: nr
                }
            });
            if (error) throw error;

            const createdId = data.user?.id;
            if (createdId) {
                const { error: pErr } = await admin
                    .from('profiles')
                    .upsert(
                        {
                            id: createdId,
                            nom,
                            prenom,
                            telephone: telCreate,
                            role: nr,
                            reservation_types: { labels: [fullName], favoriteLabel: fullName },
                            updated_at: new Date().toISOString()
                        },
                        { onConflict: 'id' }
                    );
                if (pErr) throw pErr;
            }

            return new Response(JSON.stringify({ ok: true, user: data.user }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'update_role') {
            const userId = String(body.user_id ?? '');
            const role = String(body.role ?? '').toLowerCase();
            if (!userId) {
                return new Response(JSON.stringify({ error: 'user_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!isPlanningRole(role)) {
                return new Response(
                    JSON.stringify({ error: 'Rôle invalide : admin, prof ou eleve uniquement.' }),
                    {
                        status: 400,
                        headers: { ...cors, 'Content-Type': 'application/json' }
                    }
                );
            }

            const nr = normalizePlanningRole(role);
            const { error } = await admin.from('profiles').update({ role: nr }).eq('id', userId);
            if (error) throw error;
            await admin.auth.admin.updateUserById(userId, {
                user_metadata: { role: nr }
            });

            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'update_user_email') {
            const userId = String(body.user_id ?? '');
            const email = String(body.email ?? '')
                .trim()
                .toLowerCase();
            if (!userId) {
                return new Response(JSON.stringify({ error: 'user_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!email.includes('@')) {
                return new Response(JSON.stringify({ error: 'E-mail invalide' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (userId === caller.id) {
                return new Response(
                    JSON.stringify({ error: 'Modifiez votre propre e-mail depuis votre profil / compte, pas depuis ce tableau.' }),
                    {
                        status: 400,
                        headers: { ...cors, 'Content-Type': 'application/json' }
                    }
                );
            }

            const { error } = await admin.auth.admin.updateUserById(userId, {
                email,
                email_confirm: true
            });
            if (error) throw error;

            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'update_user_nom_prenom') {
            const userId = String(body.user_id ?? '');
            const nom = String(body.nom ?? '').trim();
            const prenom = String(body.prenom ?? '').trim();
            const telUpd = Object.prototype.hasOwnProperty.call(body, 'telephone')
                ? String(body.telephone ?? '')
                      .trim()
                      .slice(0, 40)
                : null;
            if (!userId) {
                return new Response(JSON.stringify({ error: 'user_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!nom || !prenom) {
                return new Response(
                    JSON.stringify({ error: 'Le nom et le prénom sont obligatoires (champs séparés).' }),
                    { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
                );
            }
            const fullName = planningFullName(nom, prenom);

            const patch: Record<string, unknown> = { nom, prenom, updated_at: new Date().toISOString() };
            if (telUpd !== null) patch.telephone = telUpd;

            const { error: pErr } = await admin.from('profiles').update(patch).eq('id', userId);
            if (pErr) throw pErr;

            const { data: authUser, error: guErr } = await admin.auth.admin.getUserById(userId);
            if (guErr) throw guErr;
            const meta = (authUser.user?.user_metadata ?? {}) as Record<string, unknown>;
            const { error: muErr } = await admin.auth.admin.updateUserById(userId, {
                user_metadata: {
                    ...meta,
                    nom,
                    prenom,
                    display_name: fullName
                }
            });
            if (muErr) throw muErr;

            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'suspend') {
            const userId = String(body.user_id ?? '');
            if (!userId) {
                return new Response(JSON.stringify({ error: 'user_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (userId === caller.id) {
                return new Response(JSON.stringify({ error: 'Vous ne pouvez pas vous suspendre vous-même' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }

            /* Ne pas appeler planning_release_personal_calendar : le lien calendrier perso doit rester
             * (réactivation = même agenda ; évite qu’un autre compte récupère le créneau). */

            const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876600h' });
            if (error) throw error;

            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'unsuspend') {
            const userId = String(body.user_id ?? '');
            if (!userId) {
                return new Response(JSON.stringify({ error: 'user_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: 'none' });
            if (error) throw error;

            const { data: assignCode, error: assignErr } = await admin.rpc('planning_try_assign_personal_calendar', {
                p_user_id: userId
            });
            if (assignErr) throw assignErr;

            const warn =
                assignCode === 'POOL_SATURATED'
                    ? 'Compte réactivé mais aucun calendrier secondaire libre (POOL_SATURATED). Ajoutez une entrée au pool.'
                    : assignCode && assignCode !== ''
                      ? `Compte réactivé ; attention calendrier : ${assignCode}`
                      : null;

            return new Response(JSON.stringify({ ok: true, calendar_warning: warn }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'list_calendar_pool') {
            const { data, error } = await admin
                .from('google_calendar_pool')
                .select('id,google_calendar_id,label,disabled,sort_order,assigned_user_id,assigned_at,created_at')
                .order('sort_order', { ascending: true })
                .order('created_at', { ascending: true });
            if (error) throw error;
            const raw = (data ?? []) as Array<{
                id: string;
                google_calendar_id: string;
                label: string | null;
                disabled: boolean | null;
                sort_order: number | null;
                assigned_user_id: string | null;
                assigned_at: string | null;
                created_at: string | null;
            }>;
            const uids = raw.map((r) => r.assigned_user_id).filter((x): x is string => Boolean(x));
            const pmap = await profileRowsForUserIds(admin, uids);
            const rows = raw.map((row) => {
                const uid = row.assigned_user_id;
                const p = uid ? pmap.get(uid) : undefined;
                const nom = String(p?.nom ?? '').trim();
                const prenom = String(p?.prenom ?? '').trim();
                return {
                    ...row,
                    assignee_nom: nom,
                    assignee_prenom: prenom
                };
            });
            return new Response(JSON.stringify({ ok: true, rows }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'add_calendar_pool') {
            const google_calendar_id = normalizeGoogleCalendarId(String(body.google_calendar_id ?? ''));
            const label = String(body.label ?? '').trim() || null;
            const sort_order = Number.isFinite(Number(body.sort_order)) ? Math.trunc(Number(body.sort_order)) : 0;
            if (!google_calendar_id) {
                return new Response(JSON.stringify({ error: 'google_calendar_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            const { data, error } = await admin
                .from('google_calendar_pool')
                .insert({
                    google_calendar_id,
                    label,
                    sort_order,
                    disabled: false
                })
                .select('id,google_calendar_id,label,disabled,sort_order,assigned_user_id,assigned_at,created_at')
                .maybeSingle();
            if (error) throw error;

            const { error: backfillErr } = await admin.rpc('planning_backfill_unassigned_calendars');
            if (backfillErr) throw backfillErr;

            return new Response(JSON.stringify({ ok: true, row: data ?? null }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'delete_user') {
            const userId = String(body.user_id ?? '');
            if (!userId) {
                return new Response(JSON.stringify({ error: 'user_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (userId === caller.id) {
                return new Response(JSON.stringify({ error: 'Vous ne pouvez pas supprimer votre propre compte' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }

            const { error } = await admin.auth.admin.deleteUser(userId);
            if (error) throw error;

            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'set_password') {
            const userId = String(body.user_id ?? '');
            const password = String(body.password ?? '');
            if (!userId) {
                return new Response(JSON.stringify({ error: 'user_id requis' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (password.length < MIN_PASSWORD_LEN) {
                return new Response(
                    JSON.stringify({ error: `Mot de passe : au moins ${MIN_PASSWORD_LEN} caractères` }),
                    { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
                );
            }

            const { error } = await admin.auth.admin.updateUserById(userId, { password });
            if (error) throw error;

            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({ error: 'Action inconnue' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' }
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { ...cors, 'Content-Type': 'application/json' }
        });
    }
});
