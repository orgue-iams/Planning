/**
 * Charge les fragments HTML en parallèle, puis les injecte dans l’ordre (en-tête puis modales).
 */
export async function loadUIComponents() {
    const components = [
        { id: 'app-header', file: 'components/headers.html' },
        { id: 'app-modals', file: 'components/modal-login.html' },
        { id: 'app-modals', file: 'components/modal-reservation.html', append: true },
        { id: 'app-modals', file: 'components/modal-password.html', append: true },
        { id: 'app-modals', file: 'components/modal-forgot-password.html', append: true },
        { id: 'app-modals', file: 'components/modal-rules.html', append: true },
        { id: 'app-modals', file: 'components/modal-help.html', append: true },
        { id: 'app-modals', file: 'components/modal-broadcast.html', append: true },
        { id: 'app-modals', file: 'components/modal-users-admin.html', append: true },
        { id: 'app-modals', file: 'components/modal-calendar-pool.html', append: true },
        { id: 'app-modals', file: 'components/modal-announcements.html', append: true },
        { id: 'app-modals', file: 'components/modal-profile.html', append: true },
        { id: 'app-modals', file: 'components/modal-config.html', append: true },
        { id: 'app-modals', file: 'components/modal-semaines-types.html', append: true }
    ];

    const loaded = await Promise.all(
        components.map(async (comp) => {
            try {
                const response = await fetch(comp.file);
                if (!response.ok) {
                    throw new Error(String(response.status));
                }
                const html = await response.text();
                return { ...comp, html, ok: true };
            } catch (err) {
                console.error(`Erreur chargement ${comp.file}:`, err);
                return { ...comp, html: '', ok: false };
            }
        })
    );

    for (const comp of loaded) {
        if (!comp.ok || !comp.html) continue;
        try {
            const target = document.getElementById(comp.id);
            if (!target) {
                console.error(`Cible manquante #${comp.id} pour ${comp.file}`);
                continue;
            }
            if (comp.append) {
                target.insertAdjacentHTML('beforeend', comp.html);
            } else {
                target.innerHTML = comp.html;
            }
        } catch (err) {
            console.error(`Erreur injection ${comp.file}:`, err);
        }
    }
}
