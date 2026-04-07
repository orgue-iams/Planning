/**
 * Gestion des comptes (secrétaire = role admin dans profiles).
 * Secrets auto : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const MIN_PASSWORD_LEN = 6;

const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-version'
};

type GateOk = { user: { id: string; email?: string } };
type GateErr = { error: string };
async function requirePlanningAdmin(authHeader: string | null, anonKey: string, url: string): Promise<GateOk | GateErr> {
    if (!authHeader) return { error: 'Missing Authorization' };
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const {
        data: { user },
        error: uerr
    } = await userClient.auth.getUser();
    if (uerr || !user) return { error: 'Unauthorized' };
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
    if (!url || !serviceKey) {
        return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
            status: 500,
            headers: { ...cors, 'Content-Type': 'application/json' }
        });
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
                const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
                if (error) throw error;
                const users = data?.users ?? [];
                if (users.length === 0) break;

                const ids = users.map((u) => u.id);
                const { data: profs } = await admin.from('profiles').select('id,display_name,role').in('id', ids);
                const pmap = new Map((profs ?? []).map((p) => [p.id, p]));

                for (const u of users) {
                    const p = pmap.get(u.id);
                    const ban = (u as { banned_until?: string | null }).banned_until ?? null;
                    all.push({
                        id: u.id,
                        email: u.email ?? '',
                        display_name: p?.display_name ?? null,
                        role: p?.role ?? 'eleve',
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
            if (role !== 'eleve' && role !== 'prof') {
                return new Response(JSON.stringify({ error: 'Rôle invite : eleve ou prof uniquement' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
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
                    display_name: displayName || email.split('@')[0],
                    role
                }
            });
            if (error) throw error;

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
            if (!['eleve', 'prof', 'admin'].includes(role)) {
                return new Response(JSON.stringify({ error: 'Rôle invalide' }), {
                    status: 400,
                    headers: { ...cors, 'Content-Type': 'application/json' }
                });
            }

            const { error } = await admin.from('profiles').update({ role }).eq('id', userId);
            if (error) throw error;
            await admin.auth.admin.updateUserById(userId, {
                user_metadata: { role }
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
