/**
 * Ouvre une <dialog> en plein écran façon « page » avec retour « < {nom} » en haut à gauche.
 */
import { closePlanningDrawer, openPlanningDrawerInstant } from '../core/planning-drawer-ui.js';
import { showMainDrawerPanel } from '../core/drawer-help-ui.js';
import { focusPlanningDialogRoot } from './focus-planning-dialog.js';
import { isPlanningDrawerReopenSuppressed } from './planning-overlay-dismiss.js';

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
    if (routeFromDrawer.has(el.id) && !isPlanningDrawerReopenSuppressed()) openPlanningDrawerInstant();
    else closePlanningDrawer();
}

function syncPlanningRouteBackFromStack(dialogId) {
    setPlanningRouteBackHandler(dialogId, () => popPlanningRouteLevel(dialogId));
}

/**
 * Met à jour la barre (titre + retour) à partir de la pile courante.
 * @param {string} dialogId
 */
export function refreshPlanningRouteChrome(dialogId) {
    const stack = routeStacks.get(dialogId);
    if (!stack?.length) return;
    const top = stack[stack.length - 1];
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;
    if (top.ariaLabel) el.setAttribute('aria-label', top.ariaLabel);
    const bar = ensureRouteBar(el);
    const short = (top.backLabel || 'Menu').trim();
    const backText = `< ${short}`;
    const back = bar.querySelector('.planning-route-page__back');
    if (back instanceof HTMLButtonElement) {
        back.textContent = backText;
        back.setAttribute('aria-label', `Retour (${short})`);
    }
    const title = bar.querySelector('.planning-route-page__title');
    if (title) title.textContent = (top.ariaLabel || '').trim();
}

/**
 * Réinitialise la pile de navigation (racine = écran ouvert depuis le menu).
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel]
 */
export function resetPlanningRouteStack(dialogId, ariaLabel, backLabel = 'Menu') {
    routeStacks.set(dialogId, [{ ariaLabel, backLabel }]);
    refreshPlanningRouteChrome(dialogId);
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
    refreshPlanningRouteChrome(dialogId);
    syncPlanningRouteBackFromStack(dialogId);
}

/**
 * Remplace le niveau courant (sans empiler) — sous-écran dans le même dialogue.
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} backLabel
 * @param {() => void} [onPop]
 */
export function replacePlanningRouteLevel(dialogId, ariaLabel, backLabel, onPop) {
    const stack = routeStacks.get(dialogId) || [];
    if (!stack.length) {
        resetPlanningRouteStack(dialogId, ariaLabel, backLabel);
        return;
    }
    stack[stack.length - 1] = {
        ariaLabel,
        backLabel: (backLabel || stack[stack.length - 2]?.ariaLabel || 'Menu').trim(),
        onPop
    };
    routeStacks.set(dialogId, stack);
    refreshPlanningRouteChrome(dialogId);
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
    refreshPlanningRouteChrome(dialogId);
    syncPlanningRouteBackFromStack(dialogId);
    return true;
}

function ensureRouteBar(el) {
    let bar = el.querySelector(':scope > .planning-route-page__bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className =
        'planning-route-page__bar flex items-center gap-2 justify-start flex-wrap shrink-0 bg-slate-50 px-3 py-2 max-sm:pt-[max(0.35rem,env(safe-area-inset-top,0px))] dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
        'planning-route-page__back text-left text-sm font-semibold text-slate-700 hover:text-slate-900 hover:underline py-1 px-0 min-h-0 h-auto border-0 bg-transparent cursor-pointer shrink-0 dark:text-slate-200 dark:hover:text-white';
    btn.addEventListener('click', () => {
        const custom = routeBackHandlers.get(el.id);
        if (custom) {
            custom();
            return;
        }
        defaultRouteBack(el);
    });
    const title = document.createElement('span');
    title.className =
        'planning-route-page__title text-sm font-semibold text-slate-800 dark:text-slate-100 truncate min-w-0 flex-1';
    bar.appendChild(btn);
    bar.appendChild(title);
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
 * Met à jour le niveau courant de la pile puis rafraîchit la barre.
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel] Texte affiché après « < » (parent dans la hiérarchie).
 */
export function updatePlanningRouteDialog(dialogId, ariaLabel, backLabel) {
    const stack = routeStacks.get(dialogId);
    if (stack?.length) {
        stack[stack.length - 1] = {
            ...stack[stack.length - 1],
            ariaLabel: ariaLabel.trim(),
            backLabel: (backLabel ?? stack[stack.length - 1].backLabel ?? 'Menu').trim()
        };
        routeStacks.set(dialogId, stack);
    } else {
        routeStacks.set(dialogId, [{ ariaLabel, backLabel: (backLabel || 'Menu').trim() }]);
    }
    refreshPlanningRouteChrome(dialogId);
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
    openPlanningRouteDialog(dialogId);
    document.getElementById('btn-app-drawer')?.blur();
    closePlanningDrawer();
    return true;
}

/**
 * @param {string} dialogId
 * @param {string} [ariaLabel] Utilisé seulement si la pile n’existe pas encore.
 * @param {string} [backLabel]
 */
export function openPlanningRouteDialog(dialogId, ariaLabel, backLabel) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;

    el.classList.add(ROUTE_CLASS);
    ensureRouteBar(el);
    if (!routeStacks.has(dialogId)) {
        resetPlanningRouteStack(dialogId, ariaLabel || 'Menu', backLabel || 'Menu');
    } else {
        refreshPlanningRouteChrome(dialogId);
    }

    const onClose = () => {
        el.classList.remove(ROUTE_CLASS);
        routeBackHandlers.delete(dialogId);
        routeStacks.delete(dialogId);
        const fromDrawer = routeFromDrawer.has(dialogId);
        routeFromDrawer.delete(dialogId);
        if (fromDrawer && !isPlanningDrawerReopenSuppressed()) openPlanningDrawerInstant();
        el.removeEventListener('close', onClose);
    };
    el.addEventListener('close', onClose, { once: true });
    el.showModal();
    focusPlanningDialogRoot(el);
}
