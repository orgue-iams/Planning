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

function refillMotifsList(el) {
    if (!el) return;
    el.replaceChildren();
    const ul = document.createElement('ul');
    ul.className = 'list-none space-y-1.5 m-0 p-0';
    for (const lab of RESERVATION_MOTIFS) {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-2';
        const dot = document.createElement('span');
        dot.className = 'inline-block w-1.5 h-1.5 rounded-full bg-primary shrink-0';
        dot.setAttribute('aria-hidden', 'true');
        const tx = document.createElement('span');
        tx.className = 'font-semibold';
        tx.textContent = lab;
        li.append(dot, tx);
        ul.appendChild(li);
    }
    el.appendChild(ul);
}

export function initProfileLabelsUi(currentUser) {
    const btn = document.getElementById('menu-item-reservation-types');
    const dlg = document.getElementById('modal_profile_labels');
    const fav = document.getElementById('profile-favorite');
    const listEl = document.getElementById('profile-motifs-list');

    btn?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!currentUser?.email) return;
        document.getElementById('btn-user-menu')?.blur();
        const p = getProfile(currentUser.email);
        refillMotifsList(listEl);
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
