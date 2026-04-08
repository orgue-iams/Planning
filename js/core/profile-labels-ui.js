/**
 * Modale « Mes réservations type » (tous les rôles).
 */

import { showToast } from '../utils/toast.js';
import { getProfile, saveProfile } from '../utils/user-profile.js';
import { getPlanningSessionUser } from './session-user.js';

function parseTitleLines(raw) {
    return String(raw || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

function renderPreferredRadios(wrap, lines, preferredIndex) {
    if (!wrap) return;
    wrap.replaceChildren();
    if (!lines.length) {
        const p = document.createElement('p');
        p.className = 'text-[10px] text-slate-400 leading-snug m-0';
        p.textContent =
            'Ajoutez au moins une ligne ci-dessus pour choisir le titre proposé par défaut lors d’une nouvelle réservation.';
        wrap.appendChild(p);
        return;
    }
    const legend = document.createElement('p');
    legend.className = 'text-[10px] font-bold text-slate-500 mb-1.5 m-0';
    legend.textContent = 'Titre par défaut (nouvelles réservations) :';
    wrap.appendChild(legend);
    let idx = preferredIndex;
    if (idx < 0 || idx >= lines.length) idx = 0;
    lines.forEach((line, i) => {
        const label = document.createElement('label');
        label.className = 'flex items-start gap-2 cursor-pointer text-[12px] text-slate-800 leading-snug';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'profile-preferred-title';
        radio.value = String(i);
        radio.checked = i === idx;
        const span = document.createElement('span');
        span.textContent = line;
        label.append(radio, span);
        wrap.appendChild(label);
    });
}

function readPreferredIndex(wrap) {
    if (!wrap) return 0;
    const c = wrap.querySelector('input[name="profile-preferred-title"]:checked');
    const v = c ? parseInt(String(c.value), 10) : 0;
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** @type {AbortController | null} */
let profileLabelsAbort = null;

export function resetProfileLabelsUiBindings() {
    profileLabelsAbort?.abort();
    profileLabelsAbort = null;
}

export function initProfileLabelsUi(_currentUser) {
    profileLabelsAbort?.abort();
    profileLabelsAbort = new AbortController();
    const { signal } = profileLabelsAbort;

    const btn = document.getElementById('menu-item-reservation-types');
    const dlg = document.getElementById('modal_profile_labels');
    const ta = document.getElementById('profile-title-lines');
    const prefWrap = document.getElementById('profile-preferred-wrap');

    const refreshRadiosFromTextarea = () => {
        const u = getPlanningSessionUser();
        if (!u?.email || !ta || !prefWrap) return;
        const lines = parseTitleLines(ta.value);
        let preferred = readPreferredIndex(prefWrap);
        if (preferred >= lines.length) preferred = Math.max(0, lines.length - 1);
        renderPreferredRadios(prefWrap, lines, preferred);
    };

    btn?.addEventListener(
        'click',
        (e) => {
            e.preventDefault();
            const u = getPlanningSessionUser();
            if (!u?.email) return;
            document.getElementById('btn-user-menu')?.blur();
            const p = getProfile(u.email);
            if (ta) ta.value = p.titleLines.join('\n');
            renderPreferredRadios(prefWrap, p.titleLines, p.preferredIndex);
            dlg?.showModal();
        },
        { signal }
    );

    ta?.addEventListener('input', () => refreshRadiosFromTextarea(), { signal });

    document.getElementById('profile-labels-btn-close')?.addEventListener('click', () => dlg?.close(), { signal });

    document.getElementById('profile-labels-btn-save')?.addEventListener(
        'click',
        async () => {
            const u = getPlanningSessionUser();
            if (!u?.email || !ta) return;
            const lines = parseTitleLines(ta.value);
            renderPreferredRadios(prefWrap, lines, readPreferredIndex(prefWrap));
            const preferredIndex = readPreferredIndex(prefWrap);
            await saveProfile(u.email, lines, preferredIndex);
            dlg?.close();
            showToast('Réservations type enregistrées.');
        },
        { signal }
    );
}
