/**
 * Annuaire interne : tous les rôles connectés — RPC planning_directory_users.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';

let bound = false;

function renderDirectorySection(container, title, rows) {
    if (!container) return;
    container.replaceChildren();
    const h = document.createElement('p');
    h.className = 'text-[9px] font-black uppercase text-slate-500 mb-1.5 tracking-wide';
    h.textContent = title;
    container.appendChild(h);
    if (!rows.length) {
        const p = document.createElement('p');
        p.className = 'text-[10px] text-slate-500 italic';
        p.textContent = 'Aucun compte.';
        container.appendChild(p);
        return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto rounded-xl border border-slate-200';
    const table = document.createElement('table');
    table.className = 'w-full text-left text-[11px]';
    table.innerHTML = `<thead class="bg-slate-50 text-slate-600 font-bold uppercase tracking-wide">
      <tr><th class="p-2">Nom</th><th class="p-2">E-mail</th><th class="p-2">Téléphone</th></tr>
    </thead>`;
    const tb = document.createElement('tbody');
    for (const r of rows) {
        const tr = document.createElement('tr');
        tr.className = 'border-t border-slate-100';
        const name = String(r.display_name || '').trim() || '—';
        const em = String(r.email || '').trim();
        const ph = String(r.telephone || '').trim();

        const tdName = document.createElement('td');
        tdName.className = 'p-2';
        const nameEl = document.createElement('strong');
        nameEl.className = 'font-semibold text-slate-900';
        nameEl.textContent = name;
        tdName.appendChild(nameEl);
        tr.appendChild(tdName);

        const tdEmail = document.createElement('td');
        tdEmail.className = 'p-2 break-all';
        if (em.includes('@')) {
            const a = document.createElement('a');
            a.href = `mailto:${em}`;
            a.className = 'link link-primary';
            a.textContent = em;
            tdEmail.appendChild(a);
        } else {
            tdEmail.textContent = em || '—';
        }
        tr.appendChild(tdEmail);

        const tdPhone = document.createElement('td');
        tdPhone.className = 'p-2 font-mono';
        tdPhone.textContent = ph || '—';
        tr.appendChild(tdPhone);

        tb.appendChild(tr);
    }
    table.appendChild(tb);
    wrap.appendChild(table);
    container.appendChild(wrap);
}

async function loadDirectoryIntoModal() {
    const status = document.getElementById('directory-users-status');
    const secAdm = document.getElementById('directory-section-admins');
    const secProf = document.getElementById('directory-section-profs');
    const secElv = document.getElementById('directory-section-eleves');
    if (!secAdm || !secProf || !secElv) return;

    const u = getPlanningSessionUser();
    if (!u?.id || !isBackendAuthConfigured()) {
        if (status) status.textContent = 'Connectez-vous pour voir l’annuaire.';
        renderDirectorySection(secAdm, 'Administrateurs', []);
        renderDirectorySection(secProf, 'Professeurs', []);
        renderDirectorySection(secElv, 'Élèves', []);
        return;
    }

    if (status) status.textContent = 'Chargement…';
    const sb = getSupabaseClient();
    if (!sb) {
        if (status) status.textContent = 'Session indisponible.';
        return;
    }

    const { data, error } = await sb.rpc('planning_directory_users');
    if (error) {
        if (status) status.textContent = error.message || 'Erreur annuaire.';
        renderDirectorySection(secAdm, 'Administrateurs', []);
        renderDirectorySection(secProf, 'Professeurs', []);
        renderDirectorySection(secElv, 'Élèves', []);
        return;
    }

    const rows = Array.isArray(data) ? data : [];
    const admins = rows.filter((r) => String(r.role || '').toLowerCase() === 'admin');
    const profs = rows.filter((r) => String(r.role || '').toLowerCase() === 'prof');
    const eleves = rows.filter((r) => String(r.role || '').toLowerCase() === 'eleve');

    renderDirectorySection(secAdm, 'Administrateurs', admins);
    renderDirectorySection(secProf, 'Professeurs', profs);
    renderDirectorySection(secElv, 'Élèves', eleves);

    if (status) {
        status.textContent = `${rows.length} compte(s) actif(s). Les coordonnées masquées respectent les choix de chaque utilisateur (menu Mon profil).`;
    }
}

export function resetDirectoryUsersUiBindings() {
    bound = false;
}

export function initDirectoryUsersUi() {
    if (bound) return;
    bound = true;

    document.getElementById('menu-item-directory')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-header-settings')?.blur();
        const dlg = document.getElementById('modal_directory_users');
        if (!dlg) {
            showToast('Fenêtre annuaire indisponible. Rechargez la page.', 'error');
            return;
        }
        requestAnimationFrame(() => {
            void loadDirectoryIntoModal().then(() => dlg.showModal());
        });
    });

    document.getElementById('directory-users-close-btn')?.addEventListener('click', () => {
        document.getElementById('modal_directory_users')?.close();
    });
}
