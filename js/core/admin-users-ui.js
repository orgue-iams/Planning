/**
 * Modale réservée au rôle planning admin (secrétaire) — Edge Function planning-admin.
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';

function redirectBaseUrl() {
    try {
        return new URL('.', window.location.href).href;
    } catch {
        return `${window.location.origin}/`;
    }
}

function renderUsersTable(users) {
    const tb = document.getElementById('admin-users-tbody');
    if (!tb) return;
    tb.replaceChildren();
    for (const u of users) {
        const tr = document.createElement('tr');
        const suspended = u.banned_until && new Date(u.banned_until) > new Date();
        tr.innerHTML = `
            <td class="text-[10px] font-bold break-all">${escapeTd(u.email)}</td>
            <td>
                <select class="select select-xs select-bordered admin-role-sel max-w-[6.5rem]" data-user-id="${u.id}">
                    <option value="eleve" ${u.role === 'eleve' ? 'selected' : ''}>élève</option>
                    <option value="prof" ${u.role === 'prof' ? 'selected' : ''}>prof</option>
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
                </select>
            </td>
            <td class="text-[10px]">${suspended ? '<span class="text-error font-bold">Suspendu</span>' : '<span class="text-success">Actif</span>'}</td>
            <td>
                <div class="flex flex-col gap-1">
                    <button type="button" class="btn btn-xs btn-outline font-black text-[9px] admin-btn-apply" data-user-id="${u.id}">Appliquer rôle</button>
                    <button type="button" class="btn btn-xs btn-ghost font-black text-[9px] admin-btn-pw" data-email="${escapeAttr(u.email)}" data-user-id="${u.id}">Mot de passe</button>
                    ${suspended
                        ? `<button type="button" class="btn btn-xs btn-success btn-outline font-black text-[9px] admin-btn-unsuspend" data-user-id="${u.id}">Réactiver</button>`
                        : `<button type="button" class="btn btn-xs btn-warning btn-outline font-black text-[9px] admin-btn-suspend" data-user-id="${u.id}">Suspendre</button>`}
                    <button type="button" class="btn btn-xs btn-error btn-outline font-black text-[9px] admin-btn-delete" data-user-id="${u.id}">Supprimer</button>
                </div>
            </td>`;
        tb.appendChild(tr);
    }
}

function escapeTd(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
}

async function refreshUserList() {
    try {
        const res = await planningAdminInvoke('list_users', {});
        renderUsersTable(res.users || []);
    } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error');
    }
}

let adminUsersHandlersBound = false;

export function initAdminUsersUi(currentUser) {
    const show = isBackendAuthConfigured() && isAdmin(currentUser);
    document.getElementById('menu-item-users-admin-wrap')?.classList.toggle('hidden', !show);
    if (!show || adminUsersHandlersBound) return;
    adminUsersHandlersBound = true;

    document.getElementById('menu-item-users-admin')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        document.getElementById('modal_users_admin')?.showModal();
        void refreshUserList();
    });

    document.getElementById('admin-users-refresh')?.addEventListener('click', () => void refreshUserList());

    document.getElementById('admin-invite-btn')?.addEventListener('click', async () => {
        const email = document.getElementById('admin-invite-email')?.value?.trim();
        const display_name = document.getElementById('admin-invite-name')?.value?.trim() || '';
        const role = document.getElementById('admin-invite-role')?.value || 'eleve';
        if (!email) {
            showToast('Indiquez un e-mail.', 'error');
            return;
        }
        try {
            await planningAdminInvoke('invite', {
                email,
                display_name,
                role,
                redirect_to: redirectBaseUrl()
            });
            showToast('Invitation envoyée.');
            document.getElementById('admin-invite-email').value = '';
            document.getElementById('admin-invite-name').value = '';
            await refreshUserList();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        }
    });

    document.getElementById('admin-users-tbody')?.addEventListener('click', async (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        const uid = t.getAttribute('data-user-id');
        if (!uid) return;

        if (t.classList.contains('admin-btn-apply')) {
            const row = t.closest('tr');
            const sel = row?.querySelector('.admin-role-sel');
            const role = sel?.value;
            if (!role) return;
            try {
                await planningAdminInvoke('update_role', { user_id: uid, role });
                showToast('Rôle mis à jour.');
                await refreshUserList();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        }
        if (t.classList.contains('admin-btn-suspend')) {
            if (!confirm('Suspendre ce compte ?')) return;
            try {
                await planningAdminInvoke('suspend', { user_id: uid });
                showToast('Compte suspendu.');
                await refreshUserList();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        }
        if (t.classList.contains('admin-btn-unsuspend')) {
            try {
                await planningAdminInvoke('unsuspend', { user_id: uid });
                showToast('Compte réactivé.');
                await refreshUserList();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        }
        if (t.classList.contains('admin-btn-delete')) {
            if (!confirm('Supprimer définitivement ce compte ?')) return;
            try {
                await planningAdminInvoke('delete_user', { user_id: uid });
                showToast('Compte supprimé.');
                await refreshUserList();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        }
        if (t.classList.contains('admin-btn-pw')) {
            const email = t.getAttribute('data-email') || '';
            document.getElementById('admin-pw-user-id').value = uid;
            document.getElementById('admin-pw-target-email').textContent = email;
            document.getElementById('admin-pw-new').value = '';
            document.getElementById('admin-pw-new2').value = '';
            document.getElementById('modal_admin_password')?.showModal();
        }
    });

    document.getElementById('admin-pw-save')?.addEventListener('click', async () => {
        const user_id = document.getElementById('admin-pw-user-id')?.value;
        const a = document.getElementById('admin-pw-new')?.value || '';
        const b = document.getElementById('admin-pw-new2')?.value || '';
        if (a !== b) {
            showToast('Les deux mots de passe diffèrent.', 'error');
            return;
        }
        if (a.length < 6) {
            showToast('Au moins 6 caractères.', 'error');
            return;
        }
        try {
            await planningAdminInvoke('set_password', { user_id, password: a });
            showToast('Mot de passe défini.');
            document.getElementById('modal_admin_password')?.close();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        }
    });
}
