import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';

/** @type {((v: 'delete' | 'shift' | null) => void) | null} */
let pendingResolve = null;

/** @type {'ok' | 'cancel' | null} */
let dialogOutcome = null;

let listenersBound = false;

function readSelectedChoice() {
    const el = document.querySelector('input[name="indispo-series-resolution"]:checked');
    return String(el?.value || 'shift').trim() === 'delete' ? 'delete' : 'shift';
}

function finish(value) {
    const r = pendingResolve;
    pendingResolve = null;
    r?.(value);
}

/**
 * @param {{ impactedSeriesCount?: number, impactedOccurrenceCount?: number }} [opts]
 * @returns {Promise<'delete' | 'shift' | null>}
 */
export function openIndispoSeriesResolutionModal(opts = {}) {
    const dlg = document.getElementById('modal_indispo_series_resolution');
    if (!(dlg instanceof HTMLDialogElement)) {
        return Promise.resolve('shift');
    }
    const textEl = document.getElementById('indispo-series-resolution-text');
    if (textEl) {
        const nSeries = Number(opts.impactedSeriesCount || 0);
        const nOcc = Number(opts.impactedOccurrenceCount || 0);
        textEl.textContent =
            nSeries > 0
                ? `Cette indispo recouvre ${nOcc} occurrence${nOcc > 1 ? 's' : ''} sur ${nSeries} série${nSeries > 1 ? 's' : ''}. Choisissez le traitement à appliquer.`
                : `Cette indispo recouvre des occurrences périodiques. Choisissez le traitement à appliquer.`;
    }
    const shift = document.querySelector('input[name="indispo-series-resolution"][value="shift"]');
    if (shift instanceof HTMLInputElement) shift.checked = true;
    return new Promise((resolve) => {
        pendingResolve = resolve;
        dialogOutcome = null;
        dlg.showModal();
        focusPlanningDialogRoot(dlg);
    });
}

export function initIndispoSeriesResolutionUi() {
    if (listenersBound) return;
    const dlg = document.getElementById('modal_indispo_series_resolution');
    if (!(dlg instanceof HTMLDialogElement)) return;
    listenersBound = true;

    dlg.addEventListener('cancel', () => {
        dialogOutcome = 'cancel';
    });
    dlg.addEventListener('close', () => {
        if (!pendingResolve) return;
        if (dialogOutcome === 'ok') finish(readSelectedChoice());
        else finish(null);
        dialogOutcome = null;
    });

    document.getElementById('indispo-series-resolution-ok')?.addEventListener('click', () => {
        dialogOutcome = 'ok';
        dlg.close();
    });
    document.getElementById('indispo-series-resolution-cancel')?.addEventListener('click', () => {
        dialogOutcome = 'cancel';
        dlg.close();
    });
}

export function resetIndispoSeriesResolutionUiBindings() {
    pendingResolve = null;
    dialogOutcome = null;
}
