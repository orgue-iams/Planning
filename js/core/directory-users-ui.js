/**
 * Annuaire interne : tous les rôles connectés — RPC planning_directory_users.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { isLikelySessionErrorMessage, notifySessionInvalid } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';
import { isAdmin } from './auth-logic.js';
import { planningAdminInvoke } from './admin-api.js';
import { openAdminUserModalForCreate, openAdminUserModalForEdit } from './admin-users-modal-ui.js';

let bound = false;

function formatFrPhone(raw) {
    const digits = String(raw || '').replace(/\D+/g, '').slice(0, 10);
    if (!digits) return '';
    return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function hideLegacyDirectorySections(secAdm, secProf, secElv) {
    secAdm?.classList.add('hidden');
    secProf?.classList.add('hidden');
    secElv?.classList.add('hidden');
    secAdm?.replaceChildren();
    secProf?.replaceChildren();
    secElv?.replaceChildren();
}

/** Un seul tableau : en-têtes de colonnes alignés pour les 3 blocs (admin / prof / élève). */
function renderDirectoryUnified(container, admins, profs, eleves) {
    if (!container) return;
    container.replaceChildren();
    const sections = [
        { title: 'Administrateurs', rows: admins },
        { title: 'Professeurs', rows: profs },
        { title: 'Élèves', rows: eleves },
    ];

    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto rounded-xl border border-slate-200';
    const table = document.createElement('table');
    table.className =
        'w-full text-left text-[11px] max-sm:text-[10px] table-fixed border-collapse directory-users-readonly';

    const cg = document.createElement('colgroup');
    cg.innerHTML =
        '<col style="width:24%"><col style="width:50%"><col style="width:26%">';
    table.appendChild(cg);

    const thead = document.createElement('thead');
    thead.className =
        'bg-slate-50 text-slate-600 font-bold uppercase tracking-wide text-[10px] max-sm:text-[9px] border-b border-slate-200';
    thead.innerHTML = `<tr>
      <th class="p-2 max-sm:p-1.5 max-sm:pl-2 font-semibold align-bottom">Nom</th>
      <th class="p-2 max-sm:p-1.5 font-semibold align-bottom">E-mail</th>
      <th class="p-2 max-sm:p-1.5 max-sm:pr-2 font-semibold align-bottom">Tél.</th>
    </tr>`;
    table.appendChild(thead);

    for (const { title, rows } of sections) {
        const tbody = document.createElement('tbody');

        const secRow = document.createElement('tr');
        secRow.className = 'bg-slate-100/95 border-t border-slate-200';
        const secTd = document.createElement('td');
        secTd.colSpan = 3;
        secTd.className =
            'py-1.5 px-2 max-sm:py-1 max-sm:px-1.5 text-[9px] max-sm:text-[8px] font-black uppercase tracking-wide text-slate-600';
        secTd.textContent = title;
        secRow.appendChild(secTd);
        tbody.appendChild(secRow);

        if (!rows.length) {
            const tr = document.createElement('tr');
            tr.className = 'border-t border-slate-100';
            const td = document.createElement('td');
            td.colSpan = 3;
            td.className =
                'p-2 max-sm:p-1.5 text-[10px] max-sm:text-[9px] text-slate-500 italic';
            td.textContent = 'Aucun compte.';
            tr.appendChild(td);
            tbody.appendChild(tr);
        } else {
            for (const r of rows) {
                const tr = document.createElement('tr');
                tr.className = 'border-t border-slate-100';
                const name = String(r.display_name || '').trim() || '—';
                const em = String(r.email || '').trim();
                const ph = formatFrPhone(String(r.telephone || '').trim());

                const tdName = document.createElement('td');
                tdName.className = 'p-2 max-sm:p-1.5 max-sm:pl-2 align-top';
                const nameEl = document.createElement('strong');
                nameEl.className = 'font-semibold text-slate-900 leading-snug';
                nameEl.textContent = name;
                tdName.appendChild(nameEl);
                tr.appendChild(tdName);

                const tdEmail = document.createElement('td');
                tdEmail.className =
                    'p-2 max-sm:p-1.5 align-top break-words [overflow-wrap:anywhere] leading-snug';
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
                tdPhone.className =
                    'p-2 max-sm:p-1.5 max-sm:pr-2 align-top font-mono text-[10px] max-sm:text-[9px] whitespace-nowrap text-slate-800';
                tdPhone.textContent = ph || '—';
                tr.appendChild(tdPhone);

                tbody.appendChild(tr);
            }
        }

        table.appendChild(tbody);
    }

    wrap.appendChild(table);
    container.appendChild(wrap);
}

async function loadDirectoryIntoModal() {
    const status = document.getElementById('directory-users-status');
    const unified = document.getElementById('directory-readonly-unified');
    const secAdm = document.getElementById('directory-section-admins');
    const secProf = document.getElementById('directory-section-profs');
    const secElv = document.getElementById('directory-section-eleves');
    if (!unified || !secAdm || !secProf || !secElv) return;

    hideLegacyDirectorySections(secAdm, secProf, secElv);
    unified.classList.remove('hidden');

    const clearUnifiedBody = () => {
        unified.replaceChildren();
    };

    const u = getPlanningSessionUser();
    if (!u?.id || !isBackendAuthConfigured()) {
        if (status) status.textContent = 'Connectez-vous pour voir l’annuaire.';
        clearUnifiedBody();
        return;
    }

    if (status) status.textContent = 'Chargement…';
    const sb = getSupabaseClient();
    if (!sb) {
        if (status) status.textContent = 'Session indisponible.';
        clearUnifiedBody();
        return;
    }

    const { data, error } = await sb.rpc('planning_directory_users');
    if (error) {
        if (isLikelySessionErrorMessage(error)) {
            notifySessionInvalid(
                String(error.message || 'Session expirée. Reconnectez-vous.')
            );
        } else if (status) {
            status.textContent = error.message || 'Erreur annuaire.';
        }
        clearUnifiedBody();
        return;
    }

    const rows = Array.isArray(data) ? data : [];
    const admins = rows.filter((r) => String(r.role || '').toLowerCase() === 'admin');
    const profs = rows.filter((r) => String(r.role || '').toLowerCase() === 'prof');
    const eleves = rows.filter((r) => String(r.role || '').toLowerCase() === 'eleve');
    renderDirectoryUnified(unified, admins, profs, eleves);
    if (status) status.textContent = '';
}

function copyCalendarUrl(calendarId) {
    const cid = String(calendarId || '').trim();
    if (!cid) return;
    const u = new URL('https://calendar.google.com/calendar/embed');
    u.searchParams.set('src', cid);
    navigator.clipboard
        .writeText(u.toString())
        .then(() => showToast('URL calendrier copiée.'))
        .catch(() => showToast('Copie impossible.', 'error'));
}

function renderAdminDirectoryTable(users) {
    const host = document.getElementById('directory-admin-users-table');
    if (!host) return;
    host.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto rounded-xl border border-slate-200';
    const table = document.createElement('table');
    table.className =
        'directory-users-admin w-full text-left text-[11px] max-sm:text-[10px] table-fixed border-collapse';

    const cg = document.createElement('colgroup');
    cg.innerHTML =
        '<col style="width:20%"><col style="width:34%"><col style="width:18%"><col><col style="width:2.85rem">';
    table.appendChild(cg);

    const thead = document.createElement('thead');
    thead.className =
        'bg-slate-50 text-slate-600 font-bold uppercase tracking-wide text-[10px] max-sm:text-[9px] border-b border-slate-200';
    thead.innerHTML = `<tr>
        <th class="p-2 max-sm:p-1.5 max-sm:pl-2 font-semibold">Nom</th>
        <th class="p-2 max-sm:p-1.5 font-semibold">E-mail</th>
        <th class="p-2 max-sm:p-1.5 font-semibold">Tél.</th>
        <th class="p-2 max-sm:p-1.5 font-semibold">Calendrier</th>
        <th class="p-2 max-sm:p-1.5 max-sm:pr-2 w-14"></th>
      </tr>`;
    table.appendChild(thead);

    const tb = document.createElement('tbody');
    const sorted = [...users].sort((a, b) =>
        `${String(a.nom || '')} ${String(a.prenom || '')}`.localeCompare(
            `${String(b.nom || '')} ${String(b.prenom || '')}`,
            'fr'
        )
    );
    for (const r of sorted) {
        const tr = document.createElement('tr');
        tr.className = 'border-t border-slate-100';
        const label = `${String(r.prenom || '').trim()} ${String(r.nom || '').trim()}`.trim() || '—';
        const email = String(r.email || '').trim();
        const phone = formatFrPhone(String(r.telephone || '').trim()) || '—';
        const calLabel = String(r.personal_calendar_label || '').trim() || 'Non attribué';
        const calId = String(r.personal_google_calendar_id || '').trim();
        const emailCell = email
            ? `<a class="link link-primary break-words [overflow-wrap:anywhere]" href="mailto:${encodeURIComponent(email)}">${escapeHtml(email)}</a>`
            : escapeHtml('—');
        tr.innerHTML = `
          <td class="p-2 max-sm:p-1.5 max-sm:pl-2 align-top leading-snug">${escapeHtml(label)}</td>
          <td class="p-2 max-sm:p-1.5 align-top leading-snug">${emailCell}</td>
          <td class="p-2 max-sm:p-1.5 align-top font-mono text-[10px] max-sm:text-[9px] whitespace-nowrap">${escapeHtml(phone)}</td>
          <td class="p-2 max-sm:p-1.5 align-top min-w-0">
            <div class="flex items-center gap-1 min-w-0">
              <span class="truncate">${escapeHtml(calLabel)}</span>
              ${
                  calId
                      ? `<button type="button" class="btn btn-ghost btn-xs btn-square border border-slate-200 shrink-0 directory-copy-cal" data-cal-id="${escapeHtmlAttr(calId)}" aria-label="Copier l'URL du calendrier" title="Copier URL">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-4 h-4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9 9 0 019 9zM18.75 10.5h-6.75a1.125 1.125 0 00-1.125 1.125v6.75"/></svg>
                </button>`
                      : ''
              }
            </div>
          </td>
          <td class="p-2 max-sm:p-1.5 max-sm:pr-2 text-right align-top">
            <button type="button" class="btn btn-ghost btn-xs btn-square border border-slate-200 directory-edit-user" data-user-id="${escapeHtmlAttr(String(r.id || ''))}" aria-label="Modifier l'utilisateur" title="Modifier">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 3.487a2.25 2.25 0 113.182 3.182L8.25 18.463 3 21l2.537-5.25L16.862 3.487z"/></svg>
            </button>
          </td>`;
        tr.dataset.userJson = JSON.stringify(r);
        tb.appendChild(tr);
    }
    table.appendChild(tb);
    wrap.appendChild(table);
    host.appendChild(wrap);
}

async function loadAdminDirectoryIntoModal() {
    const status = document.getElementById('directory-users-status');
    const tableWrap = document.getElementById('directory-admin-users-wrap');
    document.getElementById('directory-readonly-unified')?.classList.add('hidden');
    if (status) status.textContent = 'Chargement…';
    tableWrap?.classList.remove('hidden');
    document.getElementById('directory-section-admins')?.classList.add('hidden');
    document.getElementById('directory-section-profs')?.classList.add('hidden');
    document.getElementById('directory-section-eleves')?.classList.add('hidden');
    try {
        const res = await planningAdminInvoke('list_users', {});
        const users = Array.isArray(res?.users) ? res.users : [];
        renderAdminDirectoryTable(users);
        if (status) status.textContent = `${users.length} utilisateur(s).`;
    } catch (e) {
        /* planningAdminInvoke notifie déjà en cas de session expirée. */
        if (!isLikelySessionErrorMessage(e) && status) {
            status.textContent = String(e?.message || e || 'Erreur chargement comptes.');
        }
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
            const u = getPlanningSessionUser();
            const isAdminUser = isAdmin(u);
            const addBtnWrap = document.getElementById('directory-add-user-wrap');
            addBtnWrap?.classList.toggle('hidden', !isAdminUser);
            if (isAdminUser) {
                void loadAdminDirectoryIntoModal().then(() => dlg.showModal());
            } else {
                document.getElementById('directory-admin-users-wrap')?.classList.add('hidden');
                void loadDirectoryIntoModal().then(() => dlg.showModal());
            }
        });
    });
    document.getElementById('directory-add-user-btn')?.addEventListener('click', () => {
        openAdminUserModalForCreate();
    });
    document.getElementById('directory-admin-users-table')?.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const copyBtn = t.closest('.directory-copy-cal');
        if (copyBtn instanceof HTMLButtonElement) {
            copyCalendarUrl(copyBtn.dataset.calId || '');
            return;
        }
        const editBtn = t.closest('.directory-edit-user');
        if (editBtn instanceof HTMLButtonElement) {
            const tr = editBtn.closest('tr');
            const json = tr?.dataset?.userJson || '';
            if (!json) return;
            try {
                openAdminUserModalForEdit(JSON.parse(json));
            } catch {
                showToast('Impossible d’ouvrir la fiche utilisateur.', 'error');
            }
        }
    });
    document.getElementById('modal_users_admin')?.addEventListener('close', () => {
        const u = getPlanningSessionUser();
        if (!isAdmin(u)) return;
        if (!document.getElementById('modal_directory_users')?.open) return;
        void loadAdminDirectoryIntoModal();
    });

    document.getElementById('directory-users-close-btn')?.addEventListener('click', () => {
        document.getElementById('modal_directory_users')?.close();
    });
}
