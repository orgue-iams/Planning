/**
 * Alignement ligne gabarit (Semaines A/B) après décalage d’un cours lié au gabarit.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/**
 * @param {string} startIso
 * @param {string} endIso
 */
export function occurrenceIsoToTemplateScheduleFields(startIso, endIso) {
    const s = new Date(startIso);
    const e = new Date(endIso);
    const pad = (n) => String(n).padStart(2, '0');
    const day_of_week = ((s.getDay() + 6) % 7) + 1;
    return {
        day_of_week,
        start_time: `${pad(s.getHours())}:${pad(s.getMinutes())}:00`,
        end_time: `${pad(e.getHours())}:${pad(e.getMinutes())}:00`
    };
}

/**
 * @param {string} lineId
 * @param {{ startIso: string, endIso: string, title?: string }} p
 */
export async function syncOrganWeekTemplateLineFromOccurrence(lineId, p) {
    const id = String(lineId || '').trim();
    if (!id || !isBackendAuthConfigured()) return { ok: false, error: 'Ligne gabarit introuvable.' };
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.' };
    const { day_of_week, start_time, end_time } = occurrenceIsoToTemplateScheduleFields(
        p.startIso,
        p.endIso
    );
    const title = String(p.title || '').trim() || 'Cours';
    const { error } = await sb
        .from('organ_week_template_line')
        .update({
            day_of_week,
            start_time,
            end_time,
            title,
            updated_at: new Date().toISOString()
        })
        .eq('id', id);
    if (error) return { ok: false, error: error.message };
    document.dispatchEvent(
        new CustomEvent('planning-template-line-schedule-updated', {
            detail: { lineId: id, day_of_week, start_time, end_time, title }
        })
    );
    return { ok: true, error: null };
}
