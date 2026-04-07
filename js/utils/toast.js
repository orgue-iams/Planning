/**
 * Retours utilisateur non bloquants (DaisyUI toast)
 */
export function showToast(message, variant = 'success') {
    let root = document.getElementById('toast-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'toast-root';
        root.className = 'toast toast-top toast-end z-[200] gap-2 p-0 top-4 end-4';
        document.body.appendChild(root);
    }

    const alertClass =
        variant === 'error' ? 'alert-error' : variant === 'info' ? 'alert-info' : 'alert-success';

    const el = document.createElement('div');
    el.className = `alert ${alertClass} shadow-lg text-sm max-w-[min(100vw-2rem,20rem)] py-3 px-4`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    root.appendChild(el);

    const fadeMs = 3200;
    window.setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.25s ease';
        window.setTimeout(() => el.remove(), 280);
    }, fadeMs);
}
