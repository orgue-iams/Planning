/**
 * Ouvre une <dialog> en plein écran façon « page » avec retour « < {nom} » en haut à gauche.
 */
import { openPlanningDrawer } from '../core/planning-drawer-ui.js';

const ROUTE_CLASS = 'planning-route-page';

/**
 * @param {string} dialogId
 * @param {string} ariaLabel Libellé complet (aria-label du dialogue).
 * @param {string} [backLabel] Texte après « < » sur le bouton retour (défaut = `ariaLabel`).
 */
export function openPlanningRouteDialog(dialogId, ariaLabel, backLabel) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;

    el.classList.add(ROUTE_CLASS);
    if (ariaLabel) el.setAttribute('aria-label', ariaLabel);

    const short = (backLabel || ariaLabel || 'Retour').trim();
    const backText = `< ${short}`;

    let bar = el.querySelector(':scope > .planning-route-page__bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.className =
            'planning-route-page__bar flex items-center justify-start shrink-0 bg-slate-50 px-3 py-2 max-sm:pt-[max(0.35rem,env(safe-area-inset-top,0px))] dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className =
            'planning-route-page__back text-left text-sm font-semibold text-slate-700 hover:text-slate-900 hover:underline py-1 px-0 min-h-0 h-auto border-0 bg-transparent cursor-pointer max-w-[min(100%,28rem)] truncate dark:text-slate-200 dark:hover:text-white';
        btn.setAttribute('aria-label', `Retour au menu principal (${ariaLabel || short})`);
        btn.addEventListener('click', () => {
            el.close();
            openPlanningDrawer();
        });
        bar.appendChild(btn);
        el.insertBefore(bar, el.firstChild);
    }

    const back = bar.querySelector('.planning-route-page__back');
    if (back instanceof HTMLButtonElement) {
        back.textContent = backText;
        back.setAttribute('aria-label', `Retour au menu principal (${ariaLabel || short})`);
    }

    const onClose = () => {
        el.classList.remove(ROUTE_CLASS);
        el.removeEventListener('close', onClose);
    };
    el.addEventListener('close', onClose, { once: true });
    el.showModal();
}
