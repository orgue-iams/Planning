/**
 * Confirmation in-app (évite window.confirm et le préfixe « orgue-iams.github.io indique »).
 */
import { focusPlanningDialogRoot } from './focus-planning-dialog.js';

/**
 * @param {string} message
 * @param {{ title?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export function planningConfirm(message, opts = {}) {
    const {
        title = 'Confirmation',
        confirmLabel = 'Confirmer',
        cancelLabel = 'Annuler',
        danger = false
    } = opts;

    return new Promise((resolve) => {
        const dlg = document.getElementById('modal_admin_confirm');
        const titleEl = dlg?.querySelector('.modal-box h3');
        const msg = document.getElementById('admin-confirm-message');
        const btnOk = document.getElementById('admin-confirm-ok');
        const btnCancel = document.getElementById('admin-confirm-cancel');
        if (!(dlg instanceof HTMLDialogElement) || !msg || !btnOk || !btnCancel) {
            resolve(false);
            return;
        }

        if (titleEl) titleEl.textContent = title;
        msg.textContent = message;
        btnOk.textContent = confirmLabel;
        btnCancel.textContent = cancelLabel;
        btnOk.classList.toggle('btn-error', danger);
        btnOk.classList.toggle('btn-primary', !danger);

        const cleanupAnd = (v) => {
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            dlg.removeEventListener('cancel', onCancel);
            dlg.removeEventListener('click', onBackdrop);
            btnOk.classList.remove('btn-error');
            btnOk.classList.add('btn-primary');
            dlg.close();
            resolve(v);
        };
        const onOk = () => cleanupAnd(true);
        const onCancel = () => cleanupAnd(false);
        const onBackdrop = (e) => {
            if (e.target === dlg) onCancel();
        };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        dlg.addEventListener('cancel', onCancel);
        dlg.addEventListener('click', onBackdrop);
        dlg.showModal();
        focusPlanningDialogRoot(dlg);
    });
}
