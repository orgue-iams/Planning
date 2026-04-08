/**
 * Gestion des comptes (secrétaire = role admin dans profiles).
 * Secrets auto : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const MIN_PASSWORD_LEN = 6;

/** Aligné sur public.profiles.role (check SQL). */
const PLANNING_ROLES = ['admin', 'prof', 'eleve', 'consultation'] as const;

function isPlanningRole(r: string): boolean {
    return (PLANNING_ROLES as readonly string[]).includes(r.toLowerCase());
}

function normalizePlanningRole(r: string): (typeof PLANNING_ROLES)[number] {
    const x = r.toLowerCase();
    return isPlanningRole(x) ? (x as (typeof PLANNING_ROLES)[number]) : 'eleve';
}

/** Évite les URLs `in.(id)` trop longues (liste vide / erreur silencieuse côté client). */
async function profileRowsForUserIds(
    admin: ReturnType<typeof createClient>,
    ids: string[]
): Promise<Map<string, { id: string; display_name: string | null; role: string }>> {
    const map = new Map<string, { id: string; display_name: string | null; role: string }>();
    const chunk = 40;
    for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const { data, error } = await admin.from('profiles').select('id,display_name,role').in('id', slice);
        if (error) throw error;
        for (const p of data ?? []) {
            map.set(p.id, p);
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

/** Appel direct GoTrue (même endpoint que auth-js) : évite les écarts de forme de `data` avec certains bundles Deno/esm. */
async function fetchAuthUsersPage(
    projectUrl: string,
    serviceKey: string,
    page: number,
    perPage: number
): Promise<ListedUser[]> {
    const base = projectUrl.replace(/\/$/, '');
    const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    const res = await fetch(`${base}/auth/v1/admin/users?${qs}`, {
        headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
            'Content-Type': 'application/json',
            'X-Supabase-Api-Version': '2024-01-01'
        }
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(t.trim() || `Liste utilisateurs Auth : HTTP ${res.status}`);
    }
    const body = (await res.json()) as { users?: unknown };
    return Array.isArray(body.users) ? (body.users as ListedUser[]) : [];
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
    const userClient = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${jwt}` } }
    });
    const {
        data: { user },
        error: uerr
    } = await userClient.auth.getUser(jwt);
    if (uerr || !user) {
        return { error: uerr?.message?.trim() || 'Unauthorized' };
    }
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
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
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
            const perPage = 200;
            let page = 1;
            const all: Array<{
                id: string;
                email: string;
                display_name: string | null;
                role: string;
                banned_until: string | null;
                created_at: string | null;
            }> = [];

            while (true) {
                const users = await fetchAuthUsersPage(url, serviceKey, page, perPage);
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
                        display_name: p?.display_name ?? null,
                        role: normalizePlanningRole(dbRole),
                        banned_until: ban ?? null,
                        created_at: u.created_at ?? null
                    });
                }
                if (users.length < perPage) break;
                page++;
            }

            return new Response(JSON.stringify({ ok: true, users: all }), {
                headers: { ...cors, 'Content-Type': 'application/json' }
            });
        }

        if (action === 'invite') {
            const email = String(body.email ?? '')
                .trim()
                .toLowerCase();
            const displayName = String(body.display_name ?? '').trim();
            const role = String(body.role ?? 'eleve').toLowerCase();
            const redirectTo = String(body.redirect_to ?? '').trim();

            if (!email.includes('@')) {
                return new Response(JSON.stringify({ error: 'Email invalide' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!displayName) {
                return new Response(JSON.stringify({ error: 'Le nom affiché est obligatoire.' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!isPlanningRole(role)) {
                return new Response(
                    JSON.stringify({ error: 'Rôle invalide : admin, prof, eleve ou consultation uniquement.' }),
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

            const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
                redirectTo,
                data: {
                    display_name: displayName,
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
            const displayName = String(body.display_name ?? '').trim();
            const role = String(body.role ?? 'eleve').toLowerCase();
            const password = String(body.password ?? '');

            if (!email.includes('@')) {
                return new Response(JSON.stringify({ error: 'Email invalide' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!displayName) {
                return new Response(JSON.stringify({ error: 'Le nom affiché est obligatoire.' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }
            if (!isPlanningRole(role)) {
                return new Response(
                    JSON.stringify({ error: 'Rôle invalide : admin, prof, eleve ou consultation uniquement.' }),
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
            const { data, error } = await admin.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                user_metadata: {
                    display_name: displayName,
                    role: nr
                }
            });
            if (error) throw error;

            const createdId = data.user?.id;
            if (createdId) {
                const dn = displayName.trim();
                const { error: pErr } = await admin
                    .from('profiles')
                    .upsert(
                        {
                            id: createdId,
                            display_name: dn,
                            role: nr,
                            reservation_types: { labels: [dn], favoriteLabel: dn },
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
                    JSON.stringify({ error: 'Rôle invalide : admin, prof, eleve ou consultation uniquement.' }),
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

            return new Response(JSON.stringify({ ok: true }), {
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
