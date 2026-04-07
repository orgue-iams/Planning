/**
 * Modale « Mes réservations type » (tous les rôles).
 */

import { showToast } from '../utils/toast.js';
import { getProfile, saveProfile } from '../utils/user-profile.js';
import { RESERVATION_MOTIFS } from './reservation-motifs.js';

function refillFavoriteSelect(sel, selected) {
    if (!sel) return;
    sel.innerHTML = '';
    for (const lab of RESERVATION_MOTIFS) {
        sel.add(new Option(lab, lab));
    }
    if (selected && RESERVATION_MOTIFS.includes(selected)) sel.value = selected;
    else if (RESERVATION_MOTIFS.length) sel.value = RESERVATION_MOTIFS[0];
}

export function initProfileLabelsUi(currentUser) {
    const btn = document.getElementById('menu-item-reservation-types');
    const dlg = document.getElementById('modal_profile_labels');
    const fav = document.getElementById('profile-favorite');

    btn?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!currentUser?.email) return;
        document.getElementById('btn-user-menu')?.blur();
        const p = getProfile(currentUser.email);
        refillFavoriteSelect(fav, p.favoriteLabel);
        dlg?.showModal();
    });

    document.getElementById('profile-labels-btn-close')?.addEventListener('click', () => dlg?.close());

    document.getElementById('profile-labels-btn-save')?.addEventListener('click', async () => {
        if (!currentUser?.email) return;
        await saveProfile(currentUser.email, RESERVATION_MOTIFS, fav?.value || '');
        dlg?.close();
        showToast('Réservations type enregistrées.');
    });
}
