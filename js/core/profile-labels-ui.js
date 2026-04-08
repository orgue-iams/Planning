/**
 * Modale « Mes réservations type » (tous les rôles).
 */

import { showToast } from '../utils/toast.js';
import { getProfile, saveProfile } from '../utils/user-profile.js';
import { RESERVATION_MOTIFS } from './reservation-motifs.js';

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
    const titleInput = document.getElementById('profile-default-title');
    const listEl = document.getElementById('profile-motifs-list');

    btn?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!currentUser?.email) return;
        document.getElementById('btn-user-menu')?.blur();
        const p = getProfile(currentUser.email);
        refillMotifsList(listEl);
        if (titleInput) titleInput.value = p.defaultTitle || '';
        dlg?.showModal();
    });

    document.getElementById('profile-labels-btn-close')?.addEventListener('click', () => dlg?.close());

    document.getElementById('profile-labels-btn-save')?.addEventListener('click', async () => {
        if (!currentUser?.email) return;
        await saveProfile(currentUser.email, RESERVATION_MOTIFS, titleInput?.value || '');
        dlg?.close();
        showToast('Réservations type enregistrées.');
    });
}
