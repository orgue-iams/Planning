import { getSupabaseClient } from './supabase-client.js';
import { normalizePlanningRole } from './planning-roles.js';
import { hydrateReservationTypesFromServer } from '../utils/user-profile.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';

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
        .select('nom, prenom, display_name, role, reservation_types')
        .eq('id', session.user.id)
        .maybeSingle();

    if (error) {
        console.warn('[Supabase] profiles:', error.message);
    }

    const email = session.user.email || '';
    const meta = session.user.user_metadata || {};
    const metaName = String(
        meta.full_name || meta.name || formatProfileFullName(meta.nom, meta.prenom) || meta.display_name || ''
    ).trim();
    const name =
        formatProfileFullName(data?.nom, data?.prenom) ||
        (data?.display_name && String(data.display_name).trim()) ||
        metaName ||
        email.split('@')[0] ||
        'Utilisateur';
    const role = normalizePlanningRole(data?.role);

    hydrateReservationTypesFromServer(email, data?.reservation_types);

    return { name, email, role, id: session.user.id };
}
