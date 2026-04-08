/**
 * Préférences de réservation par utilisateur : lignes de titre + ligne préférée (cache + `profiles.reservation_types`).
 */

import { getSupabaseClient, isBackendAuthConfigured } from '../core/supabase-client.js';

function storageKey(email) {
    return `orgue_iams_profile_${String(email).trim().toLowerCase()}`;
}

/** @param {unknown} raw */
function normalizeReservationPayload(raw) {
    if (raw == null) {
        return { titleLines: [], preferredIndex: 0 };
    }
    let obj = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch {
            return { titleLines: [], preferredIndex: 0 };
        }
    }
    if (typeof obj !== 'object' || !obj) {
        return { titleLines: [], preferredIndex: 0 };
    }
    const p = /** @type {Record<string, unknown>} */ (obj);

    let titleLines = [];
    if (Array.isArray(p.titleLines)) {
        titleLines = p.titleLines.map((s) => String(s).trim()).filter((s) => s.length > 0);
    }
    let preferredIndex = typeof p.preferredIndex === 'number' ? p.preferredIndex : 0;

    const defaultTitle =
        typeof p.defaultTitle === 'string'
            ? p.defaultTitle.trim()
            : typeof p.favoriteLabel === 'string'
              ? p.favoriteLabel.trim()
              : '';

    if (!titleLines.length && defaultTitle) {
        titleLines = [defaultTitle];
    }
    if (titleLines.length && preferredIndex >= titleLines.length) preferredIndex = titleLines.length - 1;
    if (titleLines.length && preferredIndex < 0) preferredIndex = 0;

    return { titleLines, preferredIndex };
}

function writeProfileLocal(email, payload) {
    const clean = normalizeReservationPayload(payload);
    localStorage.setItem(storageKey(email), JSON.stringify(clean));
}

/**
 * Après lecture du profil Supabase : si le serveur a des libellés, ils remplacent le cache local.
 * @param {string} email
 * @param {unknown} reservationTypes colonne jsonb
 */
export function hydrateReservationTypesFromServer(email, reservationTypes) {
    if (!email) return;
    writeProfileLocal(email, reservationTypes);
}

/**
 * @returns {{ titleLines: string[], preferredIndex: number, defaultTitle: string }}
 */
export function getProfile(email) {
    if (!email) return { titleLines: [], preferredIndex: 0, defaultTitle: '' };
    try {
        const raw = localStorage.getItem(storageKey(email));
        if (!raw) return { titleLines: [], preferredIndex: 0, defaultTitle: '' };
        const { titleLines, preferredIndex } = normalizeReservationPayload(raw);
        const defaultTitle =
            titleLines.length && titleLines[preferredIndex] != null
                ? titleLines[preferredIndex]
                : titleLines[0] || '';
        return { titleLines, preferredIndex, defaultTitle: String(defaultTitle || '').trim() };
    } catch {
        return { titleLines: [], preferredIndex: 0, defaultTitle: '' };
    }
}

/**
 * @param {string} email
 * @param {string[]} titleLines
 * @param {number} preferredIndex
 */
export async function saveProfile(email, titleLines, preferredIndex) {
    const lines = Array.isArray(titleLines)
        ? titleLines.map((s) => String(s).trim()).filter((s) => s.length > 0)
        : [];
    let idx = Number(preferredIndex) || 0;
    if (lines.length === 0) idx = 0;
    else if (idx < 0 || idx >= lines.length) idx = 0;

    const payload = { titleLines: lines, preferredIndex: idx };
    writeProfileLocal(email, payload);

    if (isBackendAuthConfigured()) {
        const supabase = getSupabaseClient();
        if (supabase) {
            const { data: { user } } = await supabase.auth.getUser();
            if (user?.id) {
                const { error } = await supabase
                    .from('profiles')
                    .update({
                        reservation_types: payload,
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
