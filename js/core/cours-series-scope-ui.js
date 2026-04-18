/** @type {((v: 'single' | 'future' | null) => void) | null} */
let pendingResolve = null;

/** @type {'ok' | 'cancel' | null} */
let dialogOutcome = null;

let listenersBound = false;

function readSelectedScope() {
    const el = document.querySelector('input[name="cours-series-scope"]:checked');
    const v = String(el?.value || 'single').trim();
    return v === 'future' ? 'future' : 'single';
}

function finish(value) {
    const r = pendingResolve;
    pendingResolve = null;
    r?.(value);
}

/**
 * @returns {Promise<'single' | 'future' | null>}
 */
export function openCoursSeriesScopeModal() {
    const dlg = document.getElementById('modal_cours_series_scope');
    if (!(dlg instanceof HTMLDialogElement)) {
        return Promise.resolve('single');
    }
    const single = document.querySelector('input[name="cours-series-scope"][value="single"]');
    if (single instanceof HTMLInputElement) single.checked = true;
    return new Promise((resolve) => {
        pendingResolve = resolve;
        dialogOutcome = null;
        dlg.showModal();
    });
}

export function initCoursSeriesScopeUi() {
    if (listenersBound) return;
    const dlg = document.getElementById('modal_cours_series_scope');
    if (!(dlg instanceof HTMLDialogElement)) return;
    listenersBound = true;

    dlg.addEventListener('cancel', () => {
        dialogOutcome = 'cancel';
    });
    dlg.addEventListener('close', () => {
        if (!pendingResolve) return;
        if (dialogOutcome === 'ok') finish(readSelectedScope());
        else finish(null);
        dialogOutcome = null;
    });

    document.getElementById('cours-series-scope-ok')?.addEventListener('click', () => {
        dialogOutcome = 'ok';
        dlg.close();
    });
    document.getElementById('cours-series-scope-cancel')?.addEventListener('click', () => {
        dialogOutcome = 'cancel';
        dlg.close();
    });
}

export function resetCoursSeriesScopeUiBindings() {
    pendingResolve = null;
    dialogOutcome = null;
}
