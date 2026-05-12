/**
 * Ouvre une <dialog> existante en plein écran façon « page » avec lien « Précédent » en haut à gauche.
 */
import { openPlanningDrawer } from '../core/planning-drawer-ui.js';

const ROUTE_CLASS = 'planning-route-page';

/**
 * @param {string} dialogId
 * @param {string} title Titre pour accessibilité (aria-label du dialogue).
 */
export function openPlanningRouteDialog(dialogId, title) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;

    el.classList.add(ROUTE_CLASS);
    if (title) el.setAttribute('aria-label', title);

    let bar = el.querySelector(':scope > .planning-route-page__bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.className =
            'planning-route-page__bar flex items-center shrink-0 border-b border-slate-200 bg-white px-2 py-2 max-sm:pt-[max(0.35rem,env(safe-area-inset-top,0px))]';
        bar.innerHTML = `<button type="button" class="planning-route-page__back text-left text-sm font-semibold text-slate-700 hover:text-slate-900 hover:underline py-1 px-0 min-h-0 h-auto border-0 bg-transparent cursor-pointer" aria-label="Retour au menu principal">&lt; Précédent</button>`;
        el.insertBefore(bar, el.firstChild);
        const back = bar.querySelector('.planning-route-page__back');
        back?.addEventListener('click', () => {
            el.close();
            openPlanningDrawer();
        });
    }

    const onClose = () => {
        el.classList.remove(ROUTE_CLASS);
        el.removeEventListener('close', onClose);
    };
    el.addEventListener('close', onClose, { once: true });
    el.showModal();
}
