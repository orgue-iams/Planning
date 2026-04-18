/**
 * Statistiques planning (socle UI — données agrégées à brancher ultérieurement).
 */
let bound = false;

export function initStatisticsUi() {
    if (bound) return;
    bound = true;
    document.getElementById('menu-item-statistics')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        document.getElementById('btn-header-agenda-menu')?.blur();
        document.getElementById('modal_statistics')?.showModal();
    });
    document.getElementById('statistics-close-btn')?.addEventListener('click', () => {
        document.getElementById('modal_statistics')?.close();
    });
}

export function resetStatisticsUiBindings() {
    bound = false;
}
