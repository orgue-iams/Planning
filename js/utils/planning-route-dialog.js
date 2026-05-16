/**
 * Ouvre une <dialog> en plein écran façon « page » avec retour « < {nom} » en haut à gauche.
 */
import { closePlanningDrawer, openPlanningDrawer } from '../core/planning-drawer-ui.js';
import { focusPlanningDialogRoot } from './focus-planning-dialog.js';

const ROUTE_CLASS = 'planning-route-page';

/** @type {Map<string, () => void>} */
const routeBackHandlers = new Map();

/**
 * Remplace le retour par défaut (fermer + tiroir) pour un dialogue route.
 * @param {string} dialogId
 * @param {(() => void) | null} fn
 */
export function setPlanningRouteBackHandler(dialogId, fn) {
    if (typeof fn === 'function') routeBackHandlers.set(dialogId, fn);
    else routeBackHandlers.delete(dialogId);
}

function ensureRouteBar(el) {
    let bar = el.querySelector(':scope > .planning-route-page__bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className =
        'planning-route-page__bar flex items-center justify-start shrink-0 bg-slate-50 px-3 py-2 max-sm:pt-[max(0.35rem,env(safe-area-inset-top,0px))] dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
        'planning-route-page__back text-left text-sm font-semibold text-slate-700 hover:text-slate-900 hover:underline py-1 px-0 min-h-0 h-auto border-0 bg-transparent cursor-pointer max-w-[min(100%,28rem)] dark:text-slate-200 dark:hover:text-white';
    btn.addEventListener('click', () => {
        const custom = routeBackHandlers.get(el.id);
        if (custom) {
            custom();
            return;
        }
        el.close();
        openPlanningDrawer();
    });
    bar.appendChild(btn);
    el.insertBefore(bar, el.firstChild);
    return bar;
}

/**
 * Met à jour le libellé du bouton retour sans rouvrir le dialogue.
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel]
 */
export function updatePlanningRouteDialog(dialogId, ariaLabel, backLabel) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;
    if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
    const bar = ensureRouteBar(el);
    const short = (backLabel || ariaLabel || 'Retour').trim();
    const backText = `< ${short}`;
    const back = bar.querySelector('.planning-route-page__back');
    if (back instanceof HTMLButtonElement) {
        back.textContent = backText;
        back.setAttribute('aria-label', `Retour (${ariaLabel || short})`);
    }
}

/**
 * Ouvre la page route tout de suite (évite le flash planning entre tiroir fermé et showModal).
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel]
 * @returns {boolean}
 */
export function openPlanningRouteFromDrawer(dialogId, ariaLabel, backLabel) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return false;
    openPlanningRouteDialog(dialogId, ariaLabel, backLabel);
    document.getElementById('btn-app-drawer')?.blur();
    closePlanningDrawer();
    return true;
}

/**
 * @param {string} dialogId
 * @param {string} ariaLabel Libellé complet (aria-label du dialogue).
 * @param {string} [backLabel] Texte après « < » sur le bouton retour (défaut = `ariaLabel`).
 */
export function openPlanningRouteDialog(dialogId, ariaLabel, backLabel) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;

    el.classList.add(ROUTE_CLASS);
    ensureRouteBar(el);
    updatePlanningRouteDialog(dialogId, ariaLabel, backLabel);

    const onClose = () => {
        el.classList.remove(ROUTE_CLASS);
        routeBackHandlers.delete(dialogId);
        el.removeEventListener('close', onClose);
    };
    el.addEventListener('close', onClose, { once: true });
    el.showModal();
    focusPlanningDialogRoot(el);
}
