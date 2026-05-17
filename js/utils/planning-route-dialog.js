/**
 * Ouvre une <dialog> en plein écran façon « page » avec retour « < {nom} » en haut à gauche.
 */
import { closePlanningDrawer, openPlanningDrawerInstant } from '../core/planning-drawer-ui.js';
import { showMainDrawerPanel } from '../core/drawer-help-ui.js';
import { focusPlanningDialogRoot } from './focus-planning-dialog.js';

const ROUTE_CLASS = 'planning-route-page';

/** Dialogues ouverts depuis le tiroir : retour / fermeture rouvre le menu principal. */
const routeFromDrawer = new Set();

/** @type {Map<string, () => void>} */
const routeBackHandlers = new Map();

/**
 * @typedef {{ ariaLabel: string, backLabel: string, onPop?: () => void }} PlanningRouteLevel
 */

/** @type {Map<string, PlanningRouteLevel[]>} */
const routeStacks = new Map();

function blurActiveElement() {
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) ae.blur();
}

/**
 * @param {string} dialogId
 */
export function isPlanningRouteFromDrawer(dialogId) {
    return routeFromDrawer.has(dialogId);
}

function defaultRouteBack(el) {
    el.close();
    if (routeFromDrawer.has(el.id)) openPlanningDrawerInstant();
    else closePlanningDrawer();
}

function syncPlanningRouteBackFromStack(dialogId) {
    setPlanningRouteBackHandler(dialogId, () => popPlanningRouteLevel(dialogId));
}

/**
 * Réinitialise la pile de navigation (racine = écran ouvert depuis le menu).
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel]
 */
export function resetPlanningRouteStack(dialogId, ariaLabel, backLabel = 'Menu') {
    routeStacks.set(dialogId, [{ ariaLabel, backLabel }]);
    updatePlanningRouteDialog(dialogId, ariaLabel, backLabel);
    syncPlanningRouteBackFromStack(dialogId);
}

/**
 * Empile un sous-niveau (titre = action courante, retour = parent).
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel] Libellé du parent (défaut = niveau précédent).
 * @param {() => void} [onPop] Restauration UI quand on quitte ce niveau.
 */
export function pushPlanningRouteLevel(dialogId, ariaLabel, backLabel, onPop) {
    const stack = routeStacks.get(dialogId) || [];
    const parent = stack[stack.length - 1];
    stack.push({
        ariaLabel,
        backLabel: (backLabel || parent?.ariaLabel || 'Menu').trim(),
        onPop
    });
    routeStacks.set(dialogId, stack);
    updatePlanningRouteDialog(dialogId, ariaLabel, stack[stack.length - 1].backLabel);
    syncPlanningRouteBackFromStack(dialogId);
}

/**
 * @param {string} dialogId
 * @returns {boolean} false si le dialogue a été fermé (racine atteinte).
 */
export function popPlanningRouteLevel(dialogId) {
    const stack = routeStacks.get(dialogId);
    const el = document.getElementById(dialogId);
    if (!stack?.length || !(el instanceof HTMLDialogElement)) {
        if (el instanceof HTMLDialogElement) defaultRouteBack(el);
        return false;
    }
    if (stack.length <= 1) {
        defaultRouteBack(el);
        return false;
    }
    const popped = stack.pop();
    popped?.onPop?.();
    const top = stack[stack.length - 1];
    updatePlanningRouteDialog(dialogId, top.ariaLabel, top.backLabel);
    syncPlanningRouteBackFromStack(dialogId);
    return true;
}

function ensureRouteBar(el) {
    let bar = el.querySelector(':scope > .planning-route-page__bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className =
        'planning-route-page__bar flex items-center justify-start flex-wrap shrink-0 bg-slate-50 px-3 py-2 max-sm:pt-[max(0.35rem,env(safe-area-inset-top,0px))] dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700';
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
        defaultRouteBack(el);
    });
    bar.appendChild(btn);
    el.insertBefore(bar, el.firstChild);
    return bar;
}

/**
 * Remplace le retour par défaut pour un dialogue route.
 * @param {string} dialogId
 * @param {(() => void) | null} fn
 */
export function setPlanningRouteBackHandler(dialogId, fn) {
    if (typeof fn === 'function') routeBackHandlers.set(dialogId, fn);
    else routeBackHandlers.delete(dialogId);
}

/**
 * Met à jour le libellé du bouton retour sans rouvrir le dialogue.
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel] Texte affiché après « < » (parent dans la hiérarchie).
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
        back.setAttribute('aria-label', `Retour (${short})`);
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
    blurActiveElement();
    routeFromDrawer.add(dialogId);
    resetPlanningRouteStack(dialogId, ariaLabel, backLabel || 'Menu');
    showMainDrawerPanel();
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
    if (!routeStacks.has(dialogId)) {
        resetPlanningRouteStack(dialogId, ariaLabel, backLabel || ariaLabel);
    } else {
        updatePlanningRouteDialog(dialogId, ariaLabel, backLabel);
    }

    const onClose = () => {
        el.classList.remove(ROUTE_CLASS);
        routeBackHandlers.delete(dialogId);
        routeStacks.delete(dialogId);
        const fromDrawer = routeFromDrawer.has(dialogId);
        routeFromDrawer.delete(dialogId);
        if (fromDrawer) openPlanningDrawerInstant();
        el.removeEventListener('close', onClose);
    };
    el.addEventListener('close', onClose, { once: true });
    el.showModal();
    focusPlanningDialogRoot(el);
}
