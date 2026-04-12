/**
 * Retours utilisateur non bloquants (DaisyUI toast).
 * Les <dialog> ouverts sont dans la « top layer » du navigateur : un toast dans document.body
 * reste derrière la modale et peut être invisible. On attache le conteneur au dialog ouvert
 * (priorité à #modal_semaines_types) ou au body sinon.
 * @param {number} [durationMs] temps d’affichage avant fondu (défaut 3200 ms)
 */
function getToastMountParent() {
    const semaines = document.getElementById('modal_semaines_types');
    if (semaines?.open) return semaines;
    const opened = document.querySelectorAll('dialog[open]');
    if (opened.length) return opened[opened.length - 1];
    return document.body;
}

const TOAST_MOUNT_CLASS =
    'planning-toast-mount toast toast-bottom toast-end fixed flex flex-col gap-2 p-0 bottom-4 end-4 z-[2147483647] pointer-events-none [&>.alert]:pointer-events-auto';

export function showToast(message, variant = 'success', durationMs = 3200) {
    const parent = getToastMountParent();

    let root = parent.querySelector(':scope > .planning-toast-mount');
    if (!root && parent === document.body) {
        root = document.getElementById('toast-root');
        if (root && !root.classList.contains('planning-toast-mount')) {
            root.classList.add('planning-toast-mount');
        }
    }
    if (!root) {
        root = document.createElement('div');
        if (parent === document.body) {
            root.id = 'toast-root';
        }
        root.className = TOAST_MOUNT_CLASS;
        parent.appendChild(root);
    } else {
        root.className = TOAST_MOUNT_CLASS;
        if (parent === document.body && !root.id) root.id = 'toast-root';
    }

    const alertClass =
        variant === 'error' ? 'alert-error' : variant === 'info' ? 'alert-info' : 'alert-success';

    const el = document.createElement('div');
    el.className = `alert ${alertClass} shadow-lg text-sm max-w-[min(100vw-2rem,20rem)] py-3 px-4`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    root.appendChild(el);

    const fadeMs = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 3200;
    window.setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.25s ease';
        window.setTimeout(() => el.remove(), 280);
    }, fadeMs);
}
