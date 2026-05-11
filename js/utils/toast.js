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

/* pointer-events-auto sur le montage : avec pointer-events-none, les clics traversent la zone fixe
 * et retombent sur le <dialog> parent → app.js wireDialogBackdropClose() fermait la modale (ex. gestion comptes). */
const TOAST_MOUNT_CLASS =
    'planning-toast-mount toast toast-bottom toast-end fixed flex flex-col gap-2 p-0 bottom-4 end-4 z-[2147483647] pointer-events-auto';

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

/**
 * Toast sans auto-dismiss (suivi d’opération longue). Toujours monté sur `document.body`
 * pour rester visible après fermeture d’une modale.
 * @param {string} message
 * @param {'success' | 'error' | 'info'} [variant]
 * @returns {{ setMessage: (m: string) => void, finish: (message: string, variant?: 'success' | 'error' | 'info', durationMs?: number) => void, dismiss: () => void }}
 */
export function showPersistentToast(message, variant = 'info') {
    const parent = document.body;
    let root = parent.querySelector(':scope > .planning-toast-mount');
    if (!root) {
        root = document.createElement('div');
        root.id = 'toast-root';
        root.className = TOAST_MOUNT_CLASS;
        parent.appendChild(root);
    } else {
        root.className = TOAST_MOUNT_CLASS;
        if (!root.id) root.id = 'toast-root';
    }

    const alertClass =
        variant === 'error' ? 'alert-error' : variant === 'info' ? 'alert-info' : 'alert-success';

    const el = document.createElement('div');
    el.className = `alert ${alertClass} shadow-lg text-sm max-w-[min(100vw-2rem,20rem)] py-3 px-4`;
    el.setAttribute('role', 'status');
    el.setAttribute('data-persistent-toast', '1');
    el.textContent = message;
    root.appendChild(el);

    let done = false;

    const fadeOutRemove = (durationMs) => {
        const fadeMs = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 3200;
        window.setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.25s ease';
            window.setTimeout(() => el.remove(), 280);
        }, fadeMs);
    };

    const setVariantClass = (v) => {
        const next =
            v === 'error' ? 'alert-error' : v === 'info' ? 'alert-info' : 'alert-success';
        el.className = `alert ${next} shadow-lg text-sm max-w-[min(100vw-2rem,20rem)] py-3 px-4`;
    };

    return {
        setMessage(m) {
            if (!done) el.textContent = m;
        },
        finish(finalMessage, finalVariant = 'success', durationMs = 3200) {
            if (done) return;
            done = true;
            el.textContent = finalMessage;
            setVariantClass(finalVariant);
            fadeOutRemove(durationMs);
        },
        dismiss() {
            if (done) return;
            done = true;
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.2s ease';
            window.setTimeout(() => el.remove(), 220);
        }
    };
}
