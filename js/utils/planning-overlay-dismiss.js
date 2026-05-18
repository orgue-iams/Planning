/**
 * Fermeture groupée des menus tiroirs / pages route → retour au planning.
 */
import { closePlanningDrawer } from '../core/planning-drawer-ui.js';

let suppressDrawerReopen = false;

export function isPlanningDrawerReopenSuppressed() {
    return suppressDrawerReopen;
}

/**
 * Enregistre les champs ouverts puis ferme toutes les pages route et le tiroir.
 * @param {{ save?: boolean }} [opts]
 */
export function dismissPlanningOverlaysToCalendar({ save = true } = {}) {
    if (save) {
        document.dispatchEvent(new CustomEvent('planning-overlay-flush'));
    }
    suppressDrawerReopen = true;
    try {
        for (const dlg of document.querySelectorAll('dialog.planning-route-page[open]')) {
            if (dlg instanceof HTMLDialogElement) dlg.close();
        }
        closePlanningDrawer();
    } finally {
        suppressDrawerReopen = false;
    }
}
