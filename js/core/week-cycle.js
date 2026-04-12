/**
 * Semaine A / B : repère **par professeur** (`organ_prof_week_cycle`).
 * Chaque prof a ses semaines « type A » et « type B » ; un autre prof peut avoir l’inverse la même semaine calendaire.
 * Libellé dans la barre du calendrier : **uniquement** si le profil connecté est `prof` et qu’une ligne existe (souvent après « Appliquer » le gabarit).
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { isProf } from './auth-logic.js';

/** @type {{ anchorMondayIso: string, letterAtAnchor: 'A' | 'B' } | null} */
let cachedProfWeekCycle = null;

/** État en cache pour la barre d’outils (prof connecté uniquement). */
export function getProfWeekCycleForToolbar() {
    return cachedProfWeekCycle;
}

/** À la déconnexion : éviter d’afficher le repère du prof précédent. */
export function clearProfWeekCycleCache() {
    cachedProfWeekCycle = null;
}

/** Lundi 00:00 local de la semaine calendaire contenant `d` (firstDay lundi = même convention que FC). */
export function mondayOfLocalWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - dow);
    x.setHours(0, 0, 0, 0);
    return x;
}

/** @param {string} anchorIso YYYY-MM-DD (lundi) */
export function toLocalDateFromIsoDate(anchorIso) {
    const [y, m, day] = anchorIso.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, day, 12, 0, 0, 0);
}

/** YYYY-MM-DD en heure locale (évite les surprises de `toLocaleDateString`). */
export function formatLocalYmd(d) {
    if (!d || Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
}

/**
 * Alternance lundi → lundi : même règle que le gabarit (analyse / application).
 * @param {Date} d
 * @param {string} periodStartYmd YYYY-MM-DD (n’importe quel jour de la semaine de référence)
 * @param {'A'|'B'} letterForWeekContainingStart
 * @returns {'A'|'B'|null}
 */
export function weekTypeLetterForAlternance(d, periodStartYmd, letterForWeekContainingStart) {
    const ymd = String(periodStartYmd || '').slice(0, 10);
    const start = toLocalDateFromIsoDate(ymd);
    if (Number.isNaN(start.getTime()) || !d || Number.isNaN(d.getTime())) return null;
    if (letterForWeekContainingStart !== 'A' && letterForWeekContainingStart !== 'B') return null;
    const refMon = mondayOfLocalWeek(start);
    const dMon = mondayOfLocalWeek(d);
    const diff = Math.round((dMon.getTime() - refMon.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (!Number.isFinite(diff)) return null;
    const flip = diff % 2 !== 0;
    let letter = letterForWeekContainingStart;
    if (flip) letter = letter === 'A' ? 'B' : 'A';
    return letter;
}

/**
 * Libellé barre calendrier : `anchorMondayIso` = lundi stocké après « Appliquer », `letterAtAnchor` = type sur cette semaine-là.
 * @param {string | null} anchorMondayIso
 * @param {'A'|'B'} letterAtAnchor
 * @param {Date} d — date de référence (souvent le début de la vue FC)
 */
export function weekCycleLabelForDate(anchorMondayIso, letterAtAnchor, d) {
    if (!anchorMondayIso || !d || Number.isNaN(d.getTime())) return '';
    const base = letterAtAnchor === 'B' ? 'B' : 'A';
    const letter = weekTypeLetterForAlternance(d, anchorMondayIso, base);
    if (!letter) return '';
    return letter === 'A' ? 'Semaine A' : 'Semaine B';
}

/** Normalise une colonne `date` renvoyée par PostgREST / le client. */
function pgDateToYmd(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
        const s = raw.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    }
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return formatLocalYmd(raw);
    }
    const s = String(raw);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : s.slice(0, 10);
}

/**
 * Charge le repère A/B du prof connecté (une ligne par `user_id`).
 * @param {{ id?: string, role?: string } | null} user
 */
export async function fetchWeekCycleAnchor(user) {
    cachedProfWeekCycle = null;
    if (!isBackendAuthConfigured() || !user?.id || !isProf(user)) {
        return null;
    }
    const sb = getSupabaseClient();
    if (!sb) return null;

    const { data, error } = await sb
        .from('organ_prof_week_cycle')
        .select('anchor_monday, letter_at_anchor')
        .eq('user_id', user.id)
        .maybeSingle();

    if (error) {
        console.warn('[week-cycle]', error.message);
        return null;
    }
    const mon = pgDateToYmd(data?.anchor_monday);
    const letterRaw = String(data?.letter_at_anchor ?? 'A').trim().toUpperCase();
    const letterAtAnchor = letterRaw === 'B' ? 'B' : 'A';
    if (!mon) return null;

    cachedProfWeekCycle = { anchorMondayIso: mon, letterAtAnchor };
    return cachedProfWeekCycle;
}

/**
 * Enregistre le repère personnel en base **avant** l’écriture Google (cohérence BD → agendas).
 * @param {string} userId
 * @param {string} applyStartYmd YYYY-MM-DD (n’importe quel jour de la semaine de début)
 * @param {'A'|'B'} letterForWeekContainingStart
 */
export async function saveProfWeekCycleFromApply(userId, applyStartYmd, letterForWeekContainingStart) {
    if (!isBackendAuthConfigured()) {
        return { ok: false, skipped: true };
    }
    const sb = getSupabaseClient();
    if (!sb || !userId) return { ok: false, error: 'Session indisponible.' };

    const ymd = String(applyStartYmd || '').slice(0, 10);
    if (!ymd) return { ok: false, error: 'Date invalide.' };
    const d = toLocalDateFromIsoDate(ymd);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'Date invalide.' };
    const mondayIso = formatLocalYmd(mondayOfLocalWeek(d));
    const letterAtAnchor = letterForWeekContainingStart === 'B' ? 'B' : 'A';

    const { error } = await sb.from('organ_prof_week_cycle').upsert(
        {
            user_id: userId,
            anchor_monday: mondayIso,
            letter_at_anchor: letterAtAnchor,
            updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id' }
    );
    if (error) return { ok: false, error: error.message };

    cachedProfWeekCycle = { anchorMondayIso: mondayIso, letterAtAnchor };
    return { ok: true };
}
