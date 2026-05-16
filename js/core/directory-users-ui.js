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
import { openPlanningRouteDialog } from '../utils/planning-route-dialog.js';
import { closePlanningDrawer } from './planning-drawer-ui.js';

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

function isDirectoryUserActive(r) {
    const ban = r?.banned_until;
    if (!ban) return true;
    const until = new Date(ban);
    return Number.isNaN(until.getTime()) || until <= new Date();
}

function directoryDisplayName(r) {
    const p = String(r?.prenom || '').trim();
    const n = String(r?.nom || '').trim();
    const combined = [p, n].filter(Boolean).join(' ').trim();
    if (combined) return combined;
    return String(r?.display_name || '').trim() || '—';
}

/** Annuaire lecture seule : sections + cartes empilées (pas de scroll horizontal). */
function renderDirectoryUnified(container, admins, profs, eleves) {
    if (!container) return;
    container.replaceChildren();

    const sections = [
        { title: 'Administrateurs', rows: admins },
        { title: 'Professeurs', rows: profs },
        { title: 'Élèves', rows: eleves },
    ];

    const root = document.createElement('div');
    root.className =
        'directory-users-stack min-w-0 text-[12px] sm:text-[13px] space-y-2';

    let firstSection = true;
    for (const { title, rows } of sections) {
        const block = document.createElement('div');
        if (!firstSection) block.className = 'mt-4 pt-3 border-t border-slate-200 dark:border-slate-600';
        firstSection = false;

        const head = document.createElement('p');
        head.className =
            'text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300 mb-2 m-0';
        head.textContent = title;
        block.appendChild(head);

        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'text-sm text-slate-500 dark:text-slate-400 italic m-0';
            empty.textContent = 'Aucun compte.';
            block.appendChild(empty);
            root.appendChild(block);
            continue;
        }

        const list = document.createElement('div');
        list.className = 'space-y-2';
        for (const r of rows) {
            const item = document.createElement('div');
            item.className =
                'py-3 px-3 min-w-0 rounded-xl border border-slate-200 bg-slate-50/80 dark:border-slate-600 dark:bg-slate-800/70';

            const name = directoryDisplayName(r);
            const em = String(r.email || '').trim();
            const ph = formatFrPhone(String(r.telephone || '').trim());
            const nameEl = document.createElement('p');
            nameEl.className =
                'font-semibold text-slate-900 dark:text-slate-100 leading-snug m-0 break-words';
            nameEl.style.overflowWrap = 'anywhere';
            nameEl.textContent = name;
            item.appendChild(nameEl);

            const emailRow = document.createElement('div');
            emailRow.className =
                'mt-0.5 text-[12px] sm:text-[13px] leading-snug break-words min-w-0 text-slate-700 dark:text-slate-200';
            emailRow.style.overflowWrap = 'anywhere';
            if (em.includes('@')) {
                const a = document.createElement('a');
                a.href = `mailto:${em}`;
                a.className = 'directory-user-email-link';
                a.textContent = em;
                emailRow.appendChild(a);
            } else {
                emailRow.appendChild(document.createTextNode(em || '—'));
            }
            if (ph) {
                emailRow.appendChild(document.createTextNode(` · Tél. ${ph}`));
            }
            item.appendChild(emailRow);

            list.appendChild(item);
        }
        block.appendChild(list);
        root.appendChild(block);
    }

    container.appendChild(root);
}

async function loadDirectoryIntoModal() {
    const status = document.getElementById('directory-users-status');
    const unified = document.getElementById('directory-readonly-unified');
    const secAdm = document.getElementById('directory-section-admins');
    const secProf = document.getElementById('directory-section-profs');
    const secElv = document.getElementById('directory-section-eleves');
    if (!unified || !secAdm || !secProf || !secElv) return;

    hideLegacyDirectorySections(secAdm, secProf, secElv);
    document.getElementById('directory-admin-users-wrap')?.classList.add('hidden');
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

    const rows = (Array.isArray(data) ? data : []).filter(isDirectoryUserActive);
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

    const root = document.createElement('div');
    root.className = 'directory-users-stack divide-y divide-slate-200 dark:divide-slate-600 min-w-0 text-[12px] sm:text-[13px]';

    const sorted = [...users].sort((a, b) =>
        `${String(a.nom || '')} ${String(a.prenom || '')}`.localeCompare(
            `${String(b.nom || '')} ${String(b.prenom || '')}`,
            'fr'
        )
    );

    for (const r of sorted) {
        const row = document.createElement('div');
        row.className =
            'directory-admin-user-card py-3 px-3 min-w-0 rounded-xl border border-slate-200 bg-slate-50/80 mb-2 last:mb-0 dark:border-slate-600 dark:bg-slate-800/70';
        row.dataset.userJson = JSON.stringify(r);

        const label =
            `${String(r.prenom || '').trim()} ${String(r.nom || '').trim()}`.trim() ||
            String(r.display_name || '').trim() ||
            '—';
        const email = String(r.email || '').trim();
        const phone = formatFrPhone(String(r.telephone || '').trim()) || '—';
        const calLabel = String(r.personal_calendar_label || '').trim();
        const calId = String(r.personal_google_calendar_id || '').trim();

        const top = document.createElement('div');
        top.className = 'flex items-start justify-between gap-2 min-w-0';

        const left = document.createElement('div');
        left.className = 'min-w-0 flex-1';

        const nameP = document.createElement('p');
        nameP.className =
            'font-semibold text-slate-900 leading-snug m-0 break-words dark:text-slate-100';
        nameP.style.overflowWrap = 'anywhere';
        nameP.textContent = label;
        left.appendChild(nameP);

        const emailBlock = document.createElement('div');
        emailBlock.className =
            'mt-0.5 text-[12px] sm:text-[13px] leading-snug break-words min-w-0 text-slate-700 dark:text-slate-200';
        emailBlock.style.overflowWrap = 'anywhere';
        if (email.includes('@')) {
            const a = document.createElement('a');
            a.href = `mailto:${email}`;
            a.className = 'directory-user-email-link';
            a.textContent = email;
            emailBlock.appendChild(a);
        } else {
            emailBlock.textContent = email || '—';
        }
        emailBlock.appendChild(document.createTextNode(` · Tél. ${phone}`));
        if (calLabel || calId) {
            emailBlock.appendChild(document.createTextNode(' · '));
            const calText = document.createElement('span');
            calText.textContent = calLabel || 'Agenda';
            emailBlock.appendChild(calText);
            if (calId) {
                const copyBtn = document.createElement('button');
                copyBtn.type = 'button';
                copyBtn.className =
                    'btn btn-ghost btn-xs btn-square border border-slate-200 directory-copy-cal planning-icon-btn shrink-0 ml-0.5 inline-flex';
                copyBtn.dataset.calId = calId;
                copyBtn.setAttribute('aria-label', "Copier l'URL du calendrier");
                copyBtn.title = 'Copier URL';
                copyBtn.innerHTML =
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-4 h-4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9 9 0 019 9zM18.75 10.5h-6.75a1.125 1.125 0 00-1.125 1.125v6.75"/></svg>';
                emailBlock.appendChild(copyBtn);
            }
        }
        left.appendChild(emailBlock);
        const editWrap = document.createElement('div');
        editWrap.className = 'shrink-0 pt-0.5';
        editWrap.innerHTML = `<button type="button" class="btn btn-ghost btn-xs btn-square border border-slate-200 directory-edit-user" data-user-id="${escapeHtmlAttr(String(r.id || ''))}" aria-label="Modifier l'utilisateur" title="Modifier">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 3.487a2.25 2.25 0 113.182 3.182L8.25 18.463 3 21l2.537-5.25L16.862 3.487z"/></svg>
            </button>`;

        top.appendChild(left);
        top.appendChild(editWrap);
        row.appendChild(top);
        root.appendChild(row);
    }

    host.appendChild(root);
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
        const users = (Array.isArray(res?.users) ? res.users : []).filter(isDirectoryUserActive);
        renderAdminDirectoryTable(users);
        if (status) status.textContent = '';
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
        closePlanningDrawer();
        document.getElementById('btn-app-drawer')?.blur();
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
                void loadAdminDirectoryIntoModal().then(() =>
                    openPlanningRouteDialog('modal_directory_users', 'Utilisateurs', 'Utilisateurs')
                );
            } else {
                document.getElementById('directory-admin-users-wrap')?.classList.add('hidden');
                void loadDirectoryIntoModal().then(() =>
                    openPlanningRouteDialog('modal_directory_users', 'Utilisateurs', 'Utilisateurs')
                );
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
            const entry = editBtn.closest('[data-user-json]');
            const json = entry?.dataset?.userJson || '';
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
}
