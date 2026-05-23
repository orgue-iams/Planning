/** Bouton poubelle uniforme (cartes fermetures, annuaire, agendas Google, etc.). */

export const PLANNING_ICON_DELETE_BTN_CLASS = 'planning-icon-delete-btn';

export const PLANNING_ICON_DELETE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916A2.25 2.25 0 0013.5 2.25h-3A2.25 2.25 0 008.25 4.5v.916m7.5 0a48.11 48.11 0 01-7.5 0" /></svg>';

/**
 * @param {{ ariaLabel: string, title?: string, extraClass?: string, onClick?: (ev: MouseEvent) => void }} opts
 * @returns {HTMLButtonElement}
 */
export function createPlanningIconDeleteButton(opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = [PLANNING_ICON_DELETE_BTN_CLASS, opts.extraClass || ''].filter(Boolean).join(' ');
    btn.setAttribute('aria-label', opts.ariaLabel);
    if (opts.title) btn.title = opts.title;
    btn.innerHTML = PLANNING_ICON_DELETE_SVG;
    if (typeof opts.onClick === 'function') {
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            opts.onClick(ev);
        });
    }
    return btn;
}
