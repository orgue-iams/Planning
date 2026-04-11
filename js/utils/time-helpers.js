import { getChapelSlotBounds } from '../core/organ-settings.js';

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
