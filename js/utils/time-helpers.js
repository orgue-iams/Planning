import { getChapelSlotBounds } from '../core/organ-settings.js';

/** Locale + options explicites : toujours affichage 24 h (évite AM/PM si le système est en en-US). */
export const LOCALE_FR = 'fr-FR';

export const FORMAT_TIME_24 = Object.freeze({
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
});

/**
 * Normalise une saisie « H:mm » ou « HH:mm » vers « HH:mm » (24 h), ou `null` si invalide.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeHHmmInput(raw) {
    const s = String(raw ?? '').trim();
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
        return null;
    }
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * @param {Date | number | string} d
 * @returns {string}
 */
export function formatTimeFr24(d) {
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return x.toLocaleTimeString(LOCALE_FR, { ...FORMAT_TIME_24 });
}

/**
 * Ex. « jeu. 4 14:30 » pour toasts / messages (jour court + heure 24 h).
 * @param {Date | number | string} d
 */
export function formatWeekdayDayTimeFr24(d) {
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return x.toLocaleString(LOCALE_FR, {
        weekday: 'short',
        day: 'numeric',
        ...FORMAT_TIME_24
    });
}

function hhmmToMinutes(hhmm) {
    const [h, m] = String(hhmm || '00:00')
        .slice(0, 5)
        .split(':')
        .map((x) => parseInt(x, 10));
    return (h || 0) * 60 + (m || 0);
}

/**
 * Génère les options des sélecteurs d'heures (pas de 30 min après l’heure max chapelle).
 */
export function populateTimeSelects(startId, endId) {
    const startSelect = document.getElementById(startId);
    const endSelect = document.getElementById(endId);

    if (!startSelect || !endSelect) return;

    const { slotMinTime, slotMaxTime } = getChapelSlotBounds();
    const minM = hhmmToMinutes(slotMinTime);
    const maxM = hhmmToMinutes(slotMaxTime);

    startSelect.replaceChildren();
    endSelect.replaceChildren();

    for (let t = minM; t <= maxM; t += 30) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        startSelect.add(new Option(time, time));
        endSelect.add(new Option(time, time));
    }

    if (endSelect.options.length > 2) {
        endSelect.selectedIndex = 2;
    } else if (endSelect.options.length > 1) {
        endSelect.selectedIndex = 1;
    }
}

/**
 * Remplit un <select> d’heures (même plage que la chapelle).
 * @param {HTMLSelectElement} sel
 */
export function populateTimeSelectElement(sel) {
    if (!sel) return;
    const { slotMinTime, slotMaxTime } = getChapelSlotBounds();
    const minM = hhmmToMinutes(slotMinTime);
    const maxM = hhmmToMinutes(slotMaxTime);
    sel.replaceChildren();
    for (let t = minM; t <= maxM; t += 30) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        sel.add(new Option(time, time));
    }
}
