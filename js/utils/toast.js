/**
 * Retours utilisateur non bloquants (DaisyUI toast)
 */
export function showToast(message, variant = 'success') {
    let root = document.getElementById('toast-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'toast-root';
        document.body.appendChild(root);
    }
    /* Bas-droite : ne pas recouvrir la barre fixe / menu utilisateur (haut-droite). */
    root.className = 'toast toast-bottom toast-end z-[100] gap-2 p-0 bottom-4 end-4';

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
