/**
 * Évite l’ouverture du clavier virtuel au showModal : focus sur le dialogue, pas sur un champ.
 * @param {HTMLDialogElement | null | undefined} dlg
 */
export function focusPlanningDialogRoot(dlg) {
    if (!(dlg instanceof HTMLDialogElement)) return;
    if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => {
        try {
            dlg.focus({ preventScroll: true });
        } catch {
            dlg.focus();
        }
    });
}
