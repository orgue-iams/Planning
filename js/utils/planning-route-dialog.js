/**
 * Ouvre une <dialog> existante en plein écran façon « page » avec barre Retour + titre.
 */
const ROUTE_CLASS = 'planning-route-page';

/**
 * @param {string} dialogId
 * @param {string} title
 */
export function openPlanningRouteDialog(dialogId, title) {
    const el = document.getElementById(dialogId);
    if (!(el instanceof HTMLDialogElement)) return;

    el.classList.add(ROUTE_CLASS);
    let bar = el.querySelector(':scope > .planning-route-page__bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.className =
            'planning-route-page__bar flex items-center gap-2 shrink-0 border-b border-slate-200 bg-white px-2 py-2 max-sm:pt-[max(0.35rem,env(safe-area-inset-top,0px))]';
        bar.innerHTML = `
            <button type="button" class="planning-route-page__back btn btn-ghost btn-sm btn-square min-h-8 w-8 border border-slate-200" aria-label="Retour">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <span class="planning-route-page__title font-bold text-sm text-slate-800 truncate min-w-0 flex-1"></span>`;
        el.insertBefore(bar, el.firstChild);
        const back = bar.querySelector('.planning-route-page__back');
        back?.addEventListener('click', () => {
            el.close();
        });
    }
    const titleEl = bar.querySelector('.planning-route-page__title');
    if (titleEl) titleEl.textContent = title;

    const onClose = () => {
        el.classList.remove(ROUTE_CLASS);
        el.removeEventListener('close', onClose);
    };
    el.addEventListener('close', onClose, { once: true });
    el.showModal();
}
