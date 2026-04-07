/**
 * Modale « Mes réservations type » (tous les rôles).
 */

import { showToast } from '../utils/toast.js';
import { getProfile, saveProfile } from '../utils/user-profile.js';

export function initProfileLabelsUi(currentUser) {
    const btn = document.getElementById('menu-item-reservation-types');
    const dlg = document.getElementById('modal_profile_labels');
    const ta = document.getElementById('profile-labels-lines');
    const fav = document.getElementById('profile-favorite');

    const refillFavoriteFromTextarea = () => {
        if (!fav || !ta) return;
        const lines = ta.value
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
        const uniq = [...new Set(lines)];
        const previous = fav.value;
        fav.innerHTML = '';
        for (const l of uniq) {
            fav.add(new Option(l, l));
        }
        if (uniq.includes(previous)) fav.value = previous;
        else if (uniq.length) fav.selectedIndex = 0;
    };

    ta?.addEventListener('input', refillFavoriteFromTextarea);

    btn?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!currentUser?.email) return;
        document.getElementById('btn-user-menu')?.blur();
        const p = getProfile(currentUser.email);
        if (ta) ta.value = p.labels.join('\n');
        refillFavoriteFromTextarea();
        if (p.favoriteLabel && fav) fav.value = p.favoriteLabel;
        dlg?.showModal();
    });

    document.getElementById('profile-labels-btn-close')?.addEventListener('click', () => dlg?.close());

    document.getElementById('profile-labels-btn-save')?.addEventListener('click', () => {
        if (!currentUser?.email) return;
        const lines = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
        saveProfile(currentUser.email, lines, fav?.value || '');
        dlg?.close();
        showToast('Réservations type enregistrées.');
    });
}
