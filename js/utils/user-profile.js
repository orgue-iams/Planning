/**
 * Motifs de réservation par utilisateur : cache local + persistance `profiles.reservation_types` (Supabase).
 */

import { getSupabaseClient, isBackendAuthConfigured } from '../core/supabase-client.js';
import { RESERVATION_MOTIFS, normalizeMotif } from '../core/reservation-motifs.js';

function storageKey(email) {
    return `orgue_iams_profile_${String(email).trim().toLowerCase()}`;
}

/** @param {unknown} raw @returns {{ labels: string[], favoriteLabel: string }} */
function normalizeReservationPayload(raw) {
    if (raw == null) return { labels: [], favoriteLabel: '' };
    let obj = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch {
            return { labels: [], favoriteLabel: '' };
        }
    }
    if (typeof obj !== 'object' || !obj) return { labels: [], favoriteLabel: '' };
    const p = /** @type {{ labels?: unknown, favoriteLabel?: unknown, favoriteIndex?: unknown }} */ (obj);
    const labels = Array.isArray(p.labels)
        ? [...new Set(p.labels.map((s) => String(s).trim()).filter(Boolean))]
        : [];
    let favoriteLabel = typeof p.favoriteLabel === 'string' ? p.favoriteLabel.trim() : '';
    if (typeof p.favoriteIndex === 'number' && labels[p.favoriteIndex]) {
        favoriteLabel = labels[p.favoriteIndex];
    }
    if (favoriteLabel && !labels.includes(favoriteLabel)) {
        favoriteLabel = labels[0] || '';
    }
    if (!favoriteLabel && labels.length) favoriteLabel = labels[0];
    return { labels, favoriteLabel };
}

function writeProfileLocal(email, favoriteLabel) {
    const fav = normalizeMotif(favoriteLabel);
    localStorage.setItem(
        storageKey(email),
        JSON.stringify({ labels: [...RESERVATION_MOTIFS], favoriteLabel: fav })
    );
}

/**
 * Après lecture du profil Supabase : si le serveur a des libellés, ils remplacent le cache local.
 * @param {string} email
 * @param {unknown} reservationTypes colonne jsonb
 */
export function hydrateReservationTypesFromServer(email, reservationTypes) {
    if (!email) return;
    const { labels, favoriteLabel } = normalizeReservationPayload(reservationTypes);
    const fav = normalizeMotif(favoriteLabel || labels[0] || 'Travail');
    writeProfileLocal(email, fav);
}

/** @returns {{ labels: string[], favoriteLabel: string }} */
export function getProfile(email) {
    if (!email) return { labels: [...RESERVATION_MOTIFS], favoriteLabel: 'Travail' };
    try {
        const raw = localStorage.getItem(storageKey(email));
        if (!raw) return { labels: [...RESERVATION_MOTIFS], favoriteLabel: 'Travail' };
        const { labels, favoriteLabel } = normalizeReservationPayload(raw);
        const fav = normalizeMotif(favoriteLabel || labels[0] || 'Travail');
        return { labels: [...RESERVATION_MOTIFS], favoriteLabel: fav };
    } catch {
        return { labels: [...RESERVATION_MOTIFS], favoriteLabel: 'Travail' };
    }
}

export async function saveProfile(email, _labelsIgnored, favoriteLabel) {
    writeProfileLocal(email, favoriteLabel);
    const { labels: cleaned, favoriteLabel: fav } = getProfile(email);

    if (isBackendAuthConfigured()) {
        const supabase = getSupabaseClient();
        if (supabase) {
            const { data: { user } } = await supabase.auth.getUser();
            if (user?.id) {
                const { error } = await supabase
                    .from('profiles')
                    .update({
                        reservation_types: { labels: cleaned, favoriteLabel: fav },
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', user.id);
                if (error) console.warn('[Supabase] reservation_types:', error.message);
            }
        }
    }
}

export function getFavoriteLabel(email) {
    return getProfile(email).favoriteLabel;
}
