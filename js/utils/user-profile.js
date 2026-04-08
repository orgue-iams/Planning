/**
 * Préférences de réservation par utilisateur : titre par défaut (cache local + `profiles.reservation_types`).
 */

import { getSupabaseClient, isBackendAuthConfigured } from '../core/supabase-client.js';
import { RESERVATION_MOTIFS } from '../core/reservation-motifs.js';

function storageKey(email) {
    return `orgue_iams_profile_${String(email).trim().toLowerCase()}`;
}

/** @param {unknown} raw @returns {{ labels: string[], defaultTitle: string }} */
function normalizeReservationPayload(raw) {
    if (raw == null) return { labels: [], defaultTitle: '' };
    let obj = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch {
            return { labels: [], defaultTitle: '' };
        }
    }
    if (typeof obj !== 'object' || !obj) return { labels: [], defaultTitle: '' };
    const p = /** @type {{ labels?: unknown, favoriteLabel?: unknown, favoriteIndex?: unknown, defaultTitle?: unknown }} */ (obj);
    const labels = Array.isArray(p.labels)
        ? [...new Set(p.labels.map((s) => String(s).trim()).filter(Boolean))]
        : [];
    let defaultTitle = typeof p.defaultTitle === 'string' ? p.defaultTitle.trim() : '';
    if (!defaultTitle) {
        defaultTitle = typeof p.favoriteLabel === 'string' ? p.favoriteLabel.trim() : '';
    }
    if (typeof p.favoriteIndex === 'number' && labels[p.favoriteIndex]) {
        defaultTitle = labels[p.favoriteIndex];
    }
    if (!defaultTitle && labels.length) {
        defaultTitle = labels[0];
    }
    return { labels, defaultTitle };
}

function writeProfileLocal(email, defaultTitle) {
    const clean = String(defaultTitle || '').trim();
    localStorage.setItem(
        storageKey(email),
        JSON.stringify({ labels: [...RESERVATION_MOTIFS], defaultTitle: clean })
    );
}

/**
 * Après lecture du profil Supabase : si le serveur a des libellés, ils remplacent le cache local.
 * @param {string} email
 * @param {unknown} reservationTypes colonne jsonb
 */
export function hydrateReservationTypesFromServer(email, reservationTypes) {
    if (!email) return;
    const { labels, defaultTitle } = normalizeReservationPayload(reservationTypes);
    const fallback = labels[0] || '';
    writeProfileLocal(email, defaultTitle || fallback);
}

/** @returns {{ labels: string[], defaultTitle: string }} */
export function getProfile(email) {
    if (!email) return { labels: [...RESERVATION_MOTIFS], defaultTitle: '' };
    try {
        const raw = localStorage.getItem(storageKey(email));
        if (!raw) return { labels: [...RESERVATION_MOTIFS], defaultTitle: '' };
        const { defaultTitle } = normalizeReservationPayload(raw);
        return { labels: [...RESERVATION_MOTIFS], defaultTitle: String(defaultTitle || '').trim() };
    } catch {
        return { labels: [...RESERVATION_MOTIFS], defaultTitle: '' };
    }
}

export async function saveProfile(email, _labelsIgnored, defaultTitle) {
    writeProfileLocal(email, defaultTitle);
    const { labels: cleaned, defaultTitle: title } = getProfile(email);

    if (isBackendAuthConfigured()) {
        const supabase = getSupabaseClient();
        if (supabase) {
            const { data: { user } } = await supabase.auth.getUser();
            if (user?.id) {
                const { error } = await supabase
                    .from('profiles')
                    .update({
                        reservation_types: { labels: cleaned, defaultTitle: title },
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', user.id);
                if (error) console.warn('[Supabase] reservation_types:', error.message);
            }
        }
    }
}

export function getDefaultReservationTitle(email) {
    return getProfile(email).defaultTitle;
}
