/**
 * Ouvre une <dialog> en plein écran façon « page » avec retour « < {nom} » en haut à gauche.
 */
import { closePlanningDrawer, openPlanningDrawerInstant } from '../core/planning-drawer-ui.js';
import { showMainDrawerPanel } from '../core/drawer-help-ui.js';
import { focusPlanningDialogRoot } from './focus-planning-dialog.js';
import { isPlanningDrawerReopenSuppressed } from './planning-overlay-dismiss.js';

const ROUTE_CLASS = 'planning-route-page';

/** Libellé du menu tiroir (racine uniquement — ne pas inclure dans les titres de sous-niveaux). */
export const PLANNING_ROUTE_MENU_LABEL = 'Menu';

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
/**
 * Titre affiché : sous-niveau → sans le segment « Menu » (implicite via le bouton retour).
 * @param {PlanningRouteLevel} top
 * @param {PlanningRouteLevel[]} stack
 */
function displayRouteTitle(top, stack) {
    let title = (top.ariaLabel || '').trim();
    if (stack.length > 1) {
        const menuSeg = `${PLANNING_ROUTE_MENU_LABEL} /`;
        if (title.startsWith(menuSeg)) title = title.slice(menuSeg.length).trim();
        else if (title === PLANNING_ROUTE_MENU_LABEL) title = stack[stack.length - 2]?.ariaLabel || title;
    }
    return title;
}

/**
 * @param {...string} segments
 */
export function planningRouteTitle(...segments) {
    return segments
        .map((s) => String(s || '').trim())
        .filter((s) => s && s !== PLANNING_ROUTE_MENU_LABEL)
        .join(' / ');
}

/** Masque la barre « < … » sans retirer la pile (ex. sous-modale par-dessus). */
export function setPlanningRouteBarHidden(dialogId, hidden) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLElement)) return;
    const bar = el.querySelector(':scope > .planning-route-page__bar');
    bar?.classList.toggle('hidden', hidden);
}

export function refreshPlanningRouteChrome(dialogId) {
    const stack = routeStacks.get(dialogId);
    if (!stack?.length) return;
    const top = stack[stack.length - 1];
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;
    const titleText = displayRouteTitle(top, stack);
    if (titleText) el.setAttribute('aria-label', titleText);
    const bar = ensureRouteBar(el);
    const short = (top.backLabel || PLANNING_ROUTE_MENU_LABEL).trim();
    const atRoot = stack.length <= 1;
    let nav = bar.querySelector('.planning-route-page__nav');
    if (!(nav instanceof HTMLButtonElement)) {
        const legacyBack = bar.querySelector('.planning-route-page__back');
        const legacyTitle = bar.querySelector('.planning-route-page__title');
        if (legacyBack) legacyBack.remove();
        if (legacyTitle) legacyTitle.remove();
        nav = document.createElement('button');
        nav.type = 'button';
        nav.className =
            'planning-route-page__nav planning-drawer__route-nav w-full min-w-0 text-left py-1 px-0 min-h-0 h-auto border-0 bg-transparent cursor-pointer truncate';
        nav.addEventListener('click', () => {
            const stk = routeStacks.get(el.id);
            if (stk && stk.length > 1) {
                const custom = routeBackHandlers.get(el.id);
                if (custom) custom();
                else popPlanningRouteLevel(el.id);
                return;
            }
            const custom = routeBackHandlers.get(el.id);
            if (custom) {
                custom();
                return;
            }
            defaultRouteBack(el);
        });
        bar.replaceChildren(nav);
    }
    nav.className =
        'planning-route-page__nav planning-drawer__route-nav w-full min-w-0 text-left py-1 px-0 min-h-0 h-auto border-0 bg-transparent cursor-pointer truncate';
    nav.textContent = `< ${titleText}`;
    nav.setAttribute(
        'aria-label',
        atRoot ? `Retour au menu : ${titleText}` : `Retour vers ${short} : ${titleText}`
    );
}

/**
 * Réinitialise la pile de navigation (racine = écran ouvert depuis le menu).
 * @param {string} dialogId
 * @param {string} ariaLabel
 * @param {string} [backLabel]
 */
export function resetPlanningRouteStack(dialogId, ariaLabel, backLabel = PLANNING_ROUTE_MENU_LABEL) {
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
        backLabel: (backLabel || parent?.ariaLabel || PLANNING_ROUTE_MENU_LABEL).trim(),
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
        backLabel: (backLabel || stack[stack.length - 2]?.ariaLabel || PLANNING_ROUTE_MENU_LABEL).trim(),
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
        'planning-route-page__bar shrink-0 px-3 py-2 max-sm:pt-[max(0.35rem,env(safe-area-inset-top,0px))]';
    const nav = document.createElement('button');
    nav.type = 'button';
    nav.className =
        'planning-route-page__nav planning-drawer__route-nav w-full min-w-0 text-left py-1 px-0 min-h-0 h-auto border-0 bg-transparent cursor-pointer truncate';
    nav.addEventListener('click', () => {
        const stack = routeStacks.get(el.id);
        if (stack && stack.length > 1) {
            const custom = routeBackHandlers.get(el.id);
            if (custom) custom();
            else popPlanningRouteLevel(el.id);
            return;
        }
        const custom = routeBackHandlers.get(el.id);
        if (custom) {
            custom();
            return;
        }
        defaultRouteBack(el);
    });
    bar.appendChild(nav);
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
            backLabel: (backLabel ?? stack[stack.length - 1].backLabel ?? PLANNING_ROUTE_MENU_LABEL).trim()
        };
        routeStacks.set(dialogId, stack);
    } else {
        routeStacks.set(dialogId, [{ ariaLabel, backLabel: (backLabel || PLANNING_ROUTE_MENU_LABEL).trim() }]);
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
    resetPlanningRouteStack(dialogId, ariaLabel, backLabel || PLANNING_ROUTE_MENU_LABEL);
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
        resetPlanningRouteStack(
            dialogId,
            ariaLabel || PLANNING_ROUTE_MENU_LABEL,
            backLabel || PLANNING_ROUTE_MENU_LABEL
        );
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
