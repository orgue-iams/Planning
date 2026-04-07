import { getSupabaseClient } from './supabase-client.js';

/**
 * Construit l’objet utilisateur applicatif à partir d’une session Supabase + ligne `profiles`.
 * @param {import('https://esm.sh/@supabase/supabase-js@2.49.8').Session} session
 * @returns {Promise<{ name: string, email: string, role: string, id: string } | null>}
 */
export async function fetchAppUserFromSession(session) {
    const supabase = getSupabaseClient();
    if (!supabase || !session?.user) return null;

    const { data, error } = await supabase
        .from('profiles')
        .select('display_name, role')
        .eq('id', session.user.id)
        .maybeSingle();

    if (error) {
        console.warn('[Supabase] profiles:', error.message);
    }

    const email = session.user.email || '';
    const name =
        (data?.display_name && String(data.display_name).trim()) ||
        email.split('@')[0] ||
        'Utilisateur';
    const role = data?.role && ['admin', 'prof', 'eleve'].includes(data.role) ? data.role : 'eleve';

    return { name, email, role, id: session.user.id };
}
