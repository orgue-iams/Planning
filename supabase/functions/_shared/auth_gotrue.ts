/**
 * Validation du JWT utilisateur via l’API GoTrue (même contrat que le client web).
 * Plus fiable que auth.getUser(jwt) selon les versions de @supabase/supabase-js en Deno.
 */
export async function fetchAuthUser(
    projectUrl: string,
    anonKey: string,
    accessToken: string
): Promise<{ user: { id: string; email?: string } | null; error: string | null }> {
    const base = projectUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/auth/v1/user`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey
        }
    });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const t = await res.text();
            if (t?.trim()) {
                msg = t.trim().slice(0, 300);
                try {
                    const j = JSON.parse(t) as {
                        msg?: string;
                        message?: string;
                        error_description?: string;
                    };
                    if (typeof j.msg === 'string' && j.msg.trim()) msg = j.msg.trim();
                    else if (typeof j.message === 'string' && j.message.trim()) msg = j.message.trim();
                    else if (typeof j.error_description === 'string' && j.error_description.trim()) {
                        msg = j.error_description.trim();
                    }
                } catch {
                    /* garder msg texte brut */
                }
            }
        } catch {
            /* */
        }
        return { user: null, error: msg };
    }
    const body = (await res.json()) as { id?: string; email?: string };
    if (!body?.id) return { user: null, error: 'Invalid user' };
    return { user: { id: body.id, email: body.email }, error: null };
}
