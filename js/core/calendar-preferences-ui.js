/**
 * Préférences d’affichage (thème + taille du texte FC) — contrôles dans le tiroir menu.
 */
import { getPlanningSessionUser } from './session-user.js';
import {
    getPlanningThemePref,
    setPlanningThemePref,
    getPlanningFcTextScale,
    setPlanningFcTextScale
} from '../utils/planning-theme.js';

let bound = false;

const SCALE_STEPS = /** @type {const} */ (['sm', 'md', 'lg']);

function scaleToIndex(scale) {
    const i = SCALE_STEPS.indexOf(scale === 'sm' || scale === 'lg' ? scale : 'md');
    return i >= 0 ? i : 1;
}

function indexToScale(idx) {
    const n = Math.max(0, Math.min(2, Number(idx) || 1));
    return SCALE_STEPS[n];
}

export function syncCalendarPrefControlsUi() {
    const mode = getPlanningThemePref();
    const light = document.getElementById('cal-pref-theme-light');
    const dark = document.getElementById('cal-pref-theme-dark');
    const isLight = mode !== 'dark';
    if (light instanceof HTMLButtonElement) {
        light.setAttribute('aria-pressed', isLight ? 'true' : 'false');
        light.classList.toggle('is-active', isLight);
    }
    if (dark instanceof HTMLButtonElement) {
        dark.setAttribute('aria-pressed', !isLight ? 'true' : 'false');
        dark.classList.toggle('is-active', !isLight);
    }

    const range = document.getElementById('cal-pref-text-scale');
    if (range instanceof HTMLInputElement) {
        const idx = scaleToIndex(getPlanningFcTextScale());
        range.value = String(idx);
        range.setAttribute('aria-valuenow', String(idx));
    }
}

/**
 * @param {{ getCalendar?: () => { updateSize?: () => void } | null | undefined }} ctx
 */
export function initCalendarPreferencesUi(ctx) {
    if (bound) return;
    bound = true;

    syncCalendarPrefControlsUi();

    document.getElementById('cal-pref-theme-light')?.addEventListener('click', () => {
        setPlanningThemePref('light');
        syncCalendarPrefControlsUi();
    });
    document.getElementById('cal-pref-theme-dark')?.addEventListener('click', () => {
        setPlanningThemePref('dark');
        syncCalendarPrefControlsUi();
    });

    document.getElementById('cal-pref-text-scale')?.addEventListener('input', (e) => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement)) return;
        const scale = indexToScale(el.value);
        setPlanningFcTextScale(scale);
        el.setAttribute('aria-valuenow', el.value);
        try {
            const cal = ctx.getCalendar?.();
            if (cal && typeof cal.updateSize === 'function') cal.updateSize();
        } catch {
            /* */
        }
    });
}

export function resetCalendarPreferencesUiBindings() {
    bound = false;
}
