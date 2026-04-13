/**
 * Modale réservée au rôle planning admin (secrétaire) — Edge Function planning-admin.
 */
import { isAdmin, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_LINES } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { PLANNING_ROLE_OPTIONS, normalizePlanningRole, isPlanningRole } from './planning-roles.js';
import { getPlanningSessionUser } from './session-user.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';

/** @type {string | null} */
let adminPlanningViewerId = null;

/** Évite double envoi (double clic ou écouteurs dupliqués) → deux toasts identiques. */
let adminPasswordSaveInFlight = false;

let adminCreateUserInFlight = false;
let adminInviteInFlight = false;

/** Clés `userId:kind` pour ignorer les doubles `change` / `focusout` / clic (HMR, tactiles, etc.). */
const adminRowOpLocks = new Set();

/** @returns {string | null} */
function takeAdminRowLock(userId, kind) {
    const key = `${String(userId)}:${kind}`;
    if (adminRowOpLocks.has(key)) return null;
    adminRowOpLocks.add(key);
    return key;
}

/** @param {string | null} key */
function releaseAdminRowLock(key) {
    if (key) adminRowOpLocks.delete(key);
}

/**
 * Confirmation in-app (évite window.confirm, supprimé / auto-validé par certains environnements de debug navigateur).
 */
function confirmAdminAsync(message) {
    return new Promise((resolve) => {
        const dlg = document.getElementById('modal_admin_confirm');
        const msg = document.getElementById('admin-confirm-message');
        const btnOk = document.getElementById('admin-confirm-ok');
        const btnCancel = document.getElementById('admin-confirm-cancel');
        if (!dlg || !msg || !btnOk || !btnCancel) {
            resolve(false);
            return;
        }
        msg.textContent = message;

        const cleanupAnd = (v) => {
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            dlg.removeEventListener('cancel', onCancel);
            dlg.removeEventListener('click', onBackdrop);
            dlg.close();
            resolve(v);
        };
        const onOk = () => cleanupAnd(true);
        const onCancel = () => cleanupAnd(false);
        const onBackdrop = (e) => {
            if (e.target === dlg) onCancel();
        };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        dlg.addEventListener('cancel', onCancel);
        dlg.addEventListener('click', onBackdrop);
        dlg.showModal();
    });
}

function showCopyBubbleNear(anchor, message) {
    const el = document.createElement('div');
    el.className = 'admin-copy-bubble';
    el.textContent = message;
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    el.style.left = `${r.left + r.width / 2}px`;
    el.style.top = `${r.top - 6}px`;
    window.setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.2s ease';
        window.setTimeout(() => el.remove(), 220);
    }, 2000);
}

function redirectBaseUrl() {
    try {
        return new URL('.', window.location.href).href;
    } catch {
        return `${window.location.origin}/`;
    }
}

function roleSelectOptionsHtml(selectedRole) {
    const sel = normalizePlanningRole(selectedRole);
    return PLANNING_ROLE_OPTIONS.map(
        ({ value, label }) =>
            `<option value="${value}" ${sel === value ? 'selected' : ''}>${escapeTd(label)}</option>`
    ).join('');
}

const ADMIN_CAL_URL_COPY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="shrink-0 opacity-80 group-hover:opacity-100" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9 9 0 019 9zM18.75 10.5h-6.75a1.125 1.125 0 00-1.125 1.125v6.75" /></svg>';

function sortUsersByName(users) {
    return [...users].sort((a, b) => {
        const an = String(a.nom ?? '').trim().toLowerCase();
        const bn = String(b.nom ?? '').trim().toLowerCase();
        if (an !== bn) return an.localeCompare(bn, 'fr');
        const ap = String(a.prenom ?? '').trim().toLowerCase();
        const bp = String(b.prenom ?? '').trim().toLowerCase();
        if (ap !== bp) return ap.localeCompare(bp, 'fr');
        return String(a.email ?? '')
            .toLowerCase()
            .localeCompare(String(b.email ?? '').toLowerCase(), 'fr');
    });
}

function renderUsersTable(users) {
    const tb = document.getElementById('admin-users-tbody');
    if (!tb) return;
    tb.replaceChildren();
    const list = sortUsersByName(Array.isArray(users) ? users : []);
    if (list.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="6" class="text-slate-500 text-center py-4">Aucun compte renvoyé par le serveur. Vérifiez le déploiement de la fonction « planning-admin » ou rechargez la page.</td>`;
        tb.appendChild(tr);
        return;
    }
    for (const u of list) {
        const tr = document.createElement('tr');
        const suspended = u.banned_until && new Date(u.banned_until) > new Date();
        const label = String(u.personal_calendar_label ?? '').trim();
        const hasCal = Boolean(String(u.personal_google_calendar_id ?? '').trim());
        const calIdRaw = String(u.personal_google_calendar_id ?? '').trim();
        const showCalCopy = Boolean(calIdRaw);
        const calLabelHtml = label
            ? `<span class="text-slate-800 truncate min-w-0">${escapeTd(label)}</span>`
            : hasCal
              ? '<span class="text-slate-500">Sans libellé</span>'
              : '<span class="text-slate-400">Non attribué</span>';
        const copyBtn = showCalCopy
            ? `<button type="button" class="btn btn-ghost btn-xs btn-square h-8 w-8 min-h-8 p-0 border-0 text-slate-600 hover:bg-slate-200/90 hover:text-slate-900 shrink-0 group admin-btn-copy-cal-url" data-calendar-id="${escapeAttr(calIdRaw)}" title="Copier URL" aria-label="Copier l’URL du calendrier">${ADMIN_CAL_URL_COPY_SVG}</button>`
            : '';
        const calCell = `<div class="flex items-center justify-center gap-1 min-w-0 max-w-full">${calLabelHtml}${copyBtn}</div>`;
        const nameCell = escapeTd(
            formatProfileFullName(u.nom, u.prenom) || String(u.display_name ?? '').trim() || '—'
        );
        const emailRaw = String(u.email ?? '').trim();
        const emailAttr = escapeHtmlAttr(emailRaw);
        const viewerId = String(adminPlanningViewerId ?? getPlanningSessionUser()?.id ?? '');
        const emailReadonly = viewerId !== '' && String(u.id) === viewerId;
        const emailInput = emailReadonly
            ? `<span class="break-all text-slate-500" title="Votre propre e-mail ne peut pas être modifié ici.">${escapeTd(emailRaw)}</span>`
            : `<input type="email" class="input input-xs input-bordered w-full min-w-0 admin-user-email" data-user-id="${escapeAttr(u.id)}" data-initial-email="${emailAttr}" value="${emailAttr}" autocomplete="off" />`;
        tr.innerHTML = `
            <td class="align-middle text-slate-900">${nameCell}</td>
            <td class="break-all align-middle">${emailInput}</td>
            <td class="align-middle">
                <select class="select select-xs select-bordered admin-role-sel w-full max-w-[9.5rem]" data-user-id="${escapeAttr(u.id)}">
                    ${roleSelectOptionsHtml(u.role)}
                </select>
            </td>
            <td class="align-middle">
                <select class="select select-xs select-bordered admin-status-sel w-full max-w-[7.5rem] py-0" data-user-id="${escapeAttr(u.id)}" aria-label="Statut du compte">
                    <option value="active" ${!suspended ? 'selected' : ''}>Actif</option>
                    <option value="suspended" ${suspended ? 'selected' : ''}>Suspendu</option>
                </select>
            </td>
            <td class="align-middle">${calCell}</td>
            <td class="align-middle">
                <div class="flex flex-col sm:flex-row sm:flex-wrap gap-1 sm:gap-1.5 justify-center">
                    <button type="button" class="btn btn-xs btn-outline border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-100 shrink-0 admin-btn-pw" data-email="${escapeAttr(u.email)}" data-user-id="${escapeAttr(u.id)}">Mot de passe</button>
                    <button type="button" class="btn btn-xs btn-error btn-outline shrink-0 admin-btn-delete" data-user-id="${escapeAttr(u.id)}">Supprimer</button>
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

function escapeHtmlAttr(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

async function refreshUserList() {
    try {
        const res = await planningAdminInvoke('list_users', {});
        renderUsersTable(res.users || []);
    } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error');
    }
}

function setAdminCreatePassVisible(visible) {
    const pw = document.getElementById('admin-create-password');
    const btn = document.getElementById('admin-create-pw-toggle');
    const iconShow = document.getElementById('admin-create-pw-icon-show');
    const iconHide = document.getElementById('admin-create-pw-icon-hide');
    pw?.setAttribute('type', visible ? 'text' : 'password');
    btn?.setAttribute('aria-pressed', String(visible));
    btn?.setAttribute(
        'aria-label',
        visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'
    );
    iconShow?.classList.toggle('hidden', visible);
    iconHide?.classList.toggle('hidden', !visible);
}

function resetCreateInviteForm() {
    const emailEl = document.getElementById('admin-invite-email');
    const nomEl = document.getElementById('admin-invite-nom');
    const prenomEl = document.getElementById('admin-invite-prenom');
    const pwEl = document.getElementById('admin-create-password');
    const roleSel = document.getElementById('admin-invite-role');
    if (emailEl) emailEl.value = '';
    if (nomEl) nomEl.value = '';
    if (prenomEl) prenomEl.value = '';
    if (pwEl) pwEl.value = '';
    setAdminCreatePassVisible(false);
    if (roleSel) roleSel.value = 'eleve';
}

function fillPasswordPolicyLists() {
    const pwUl = document.getElementById('admin-pw-policy');
    if (pwUl) {
        pwUl.replaceChildren();
        for (const line of PASSWORD_POLICY_LINES) {
            const li = document.createElement('li');
            li.textContent = line;
            pwUl.appendChild(li);
        }
    }
    const createUl = document.getElementById('admin-create-pw-policy');
    if (createUl) {
        createUl.replaceChildren();
        for (const line of PASSWORD_POLICY_LINES) {
            const li = document.createElement('li');
            li.textContent = line;
            createUl.appendChild(li);
        }
    }
}

function setAdminPwFieldsVisible(visible) {
    const t = visible ? 'text' : 'password';
    document.getElementById('admin-pw-new')?.setAttribute('type', t);
    document.getElementById('admin-pw-new2')?.setAttribute('type', t);
}

let adminUsersHandlersBound = false;

export function resetAdminUsersUiBindings() {
    adminUsersHandlersBound = false;
    adminPlanningViewerId = null;
    adminRowOpLocks.clear();
}

export function initAdminUsersUi(currentUser) {
    const show = isBackendAuthConfigured() && isAdmin(currentUser);
    document.getElementById('menu-item-users-admin-wrap')?.classList.toggle('hidden', !show);
    if (!show || adminUsersHandlersBound) return;
    adminUsersHandlersBound = true;
    adminPlanningViewerId = currentUser?.id != null ? String(currentUser.id) : null;

    fillPasswordPolicyLists();

    const usersAdminDlg = document.getElementById('modal_users_admin');
    usersAdminDlg?.addEventListener('click', (e) => {
        if (e.target === usersAdminDlg) usersAdminDlg.close();
    });

    document.getElementById('admin-pw-show-plain')?.addEventListener('change', (e) => {
        const el = e.target;
        setAdminPwFieldsVisible(el instanceof HTMLInputElement && el.checked);
    });

    document.getElementById('admin-create-pw-toggle')?.addEventListener('click', () => {
        const pw = document.getElementById('admin-create-password');
        const vis = pw?.getAttribute('type') === 'text';
        setAdminCreatePassVisible(!vis);
    });

    document.getElementById('menu-item-users-admin')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        const dlg = document.getElementById('modal_users_admin');
        if (!dlg) {
            showToast('Fenêtre de gestion indisponible. Rechargez la page.', 'error');
            return;
        }
        /* Après fermeture du menu DaisyUI, ouvrir au frame suivant évite un conflit tactiles / focus. */
        requestAnimationFrame(() => {
            dlg.show();
            void refreshUserList();
        });
    });

    document.getElementById('admin-create-btn')?.addEventListener('click', async () => {
        if (adminCreateUserInFlight) return;
        adminCreateUserInFlight = true;
        const btn = document.getElementById('admin-create-btn');
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const nomEl = document.getElementById('admin-invite-nom');
            const prenomEl = document.getElementById('admin-invite-prenom');
            const emailEl = document.getElementById('admin-invite-email');
            if (nomEl && !nomEl.checkValidity()) {
                nomEl.reportValidity();
                return;
            }
            if (prenomEl && !prenomEl.checkValidity()) {
                prenomEl.reportValidity();
                return;
            }
            if (emailEl && !emailEl.checkValidity()) {
                emailEl.reportValidity();
                return;
            }
            const email = emailEl?.value?.trim();
            const nom = nomEl?.value?.trim() || '';
            const prenom = prenomEl?.value?.trim() || '';
            const password = document.getElementById('admin-create-password')?.value || '';
            const role = document.getElementById('admin-invite-role')?.value || 'eleve';
            if (!email) {
                showToast('Indiquez un e-mail.', 'error');
                return;
            }
            if (!nom || !prenom) {
                showToast('Le nom et le prénom sont obligatoires.', 'error');
                return;
            }
            if (!isPlanningRole(role)) {
                showToast('Rôle invalide.', 'error');
                return;
            }
            if (password.length < PASSWORD_MIN_LENGTH) {
                showToast(`Mot de passe : au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
                return;
            }
            try {
                await planningAdminInvoke('create_user', {
                    email,
                    nom,
                    prenom,
                    role,
                    password
                });
                showToast('Compte créé.');
                resetCreateInviteForm();
                await refreshUserList();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        } finally {
            adminCreateUserInFlight = false;
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    document.getElementById('admin-invite-btn')?.addEventListener('click', async () => {
        if (adminInviteInFlight) return;
        adminInviteInFlight = true;
        const btn = document.getElementById('admin-invite-btn');
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const nomEl = document.getElementById('admin-invite-nom');
            const prenomEl = document.getElementById('admin-invite-prenom');
            const emailEl = document.getElementById('admin-invite-email');
            if (nomEl && !nomEl.checkValidity()) {
                nomEl.reportValidity();
                return;
            }
            if (prenomEl && !prenomEl.checkValidity()) {
                prenomEl.reportValidity();
                return;
            }
            if (emailEl && !emailEl.checkValidity()) {
                emailEl.reportValidity();
                return;
            }
            const email = emailEl?.value?.trim();
            const nom = nomEl?.value?.trim() || '';
            const prenom = prenomEl?.value?.trim() || '';
            const role = document.getElementById('admin-invite-role')?.value || 'eleve';
            if (!email) {
                showToast('Indiquez un e-mail.', 'error');
                return;
            }
            if (!nom || !prenom) {
                showToast('Le nom et le prénom sont obligatoires.', 'error');
                return;
            }
            if (!isPlanningRole(role)) {
                showToast('Rôle invalide.', 'error');
                return;
            }
            try {
                await planningAdminInvoke('invite', {
                    email,
                    nom,
                    prenom,
                    role,
                    redirect_to: redirectBaseUrl()
                });
                showToast('Invitation envoyée.');
                resetCreateInviteForm();
                await refreshUserList();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        } finally {
            adminInviteInFlight = false;
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    document.getElementById('admin-users-tbody')?.addEventListener('focusout', async (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLInputElement) || !t.classList.contains('admin-user-email')) return;
        const uid = t.getAttribute('data-user-id');
        const initial = String(t.getAttribute('data-initial-email') ?? '')
            .trim()
            .toLowerCase();
        const next = t.value.trim().toLowerCase();
        if (!uid || next === initial) return;
        if (!next.includes('@')) {
            showToast('E-mail invalide.', 'error');
            t.value = String(t.getAttribute('data-initial-email') ?? '');
            return;
        }
        const lockKey = takeAdminRowLock(uid, 'email');
        if (!lockKey) return;
        try {
            try {
                await planningAdminInvoke('update_user_email', { user_id: uid, email: next });
                showToast('E-mail enregistré.');
                await refreshUserList();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
                await refreshUserList();
            }
        } finally {
            releaseAdminRowLock(lockKey);
        }
    });

    document.getElementById('admin-users-tbody')?.addEventListener('change', async (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLSelectElement)) return;
        const uid = t.getAttribute('data-user-id');
        if (!uid) return;

        if (t.classList.contains('admin-role-sel')) {
            const role = t.value;
            if (!role || !isPlanningRole(role)) return;
            const lockKey = takeAdminRowLock(uid, 'role');
            if (!lockKey) return;
            try {
                try {
                    await planningAdminInvoke('update_role', { user_id: uid, role: normalizePlanningRole(role) });
                    showToast('Rôle enregistré.');
                    await refreshUserList();
                } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), 'error');
                    await refreshUserList();
                }
            } finally {
                releaseAdminRowLock(lockKey);
            }
            return;
        }

        if (t.classList.contains('admin-status-sel')) {
            const v = t.value;
            const lockKey = takeAdminRowLock(uid, 'status');
            if (!lockKey) return;
            try {
                if (v === 'suspended') {
                    if (!confirm('Suspendre ce compte ?')) {
                        t.value = 'active';
                        return;
                    }
                    try {
                        await planningAdminInvoke('suspend', { user_id: uid });
                        showToast('Statut enregistré : compte suspendu.');
                        await refreshUserList();
                    } catch (err) {
                        showToast(err instanceof Error ? err.message : String(err), 'error');
                        await refreshUserList();
                    }
                } else {
                    try {
                        const res = await planningAdminInvoke('unsuspend', { user_id: uid });
                        if (res.calendar_warning) {
                            showToast(res.calendar_warning, 'info');
                        } else {
                            showToast('Statut enregistré : compte actif.');
                        }
                        await refreshUserList();
                    } catch (err) {
                        showToast(err instanceof Error ? err.message : String(err), 'error');
                        await refreshUserList();
                    }
                }
            } finally {
                releaseAdminRowLock(lockKey);
            }
        }
    });

    document.getElementById('admin-users-tbody')?.addEventListener('click', async (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;

        const copyBtn = t.closest('.admin-btn-copy-cal-url');
        if (copyBtn instanceof HTMLButtonElement) {
            const cid = copyBtn.getAttribute('data-calendar-id')?.trim();
            const url = cid ? googleCalendarEmbedUrl(cid) : '';
            if (!url) {
                showToast('Aucune URL d’agenda à copier.', 'error');
                return;
            }
            try {
                await navigator.clipboard.writeText(url);
                showCopyBubbleNear(copyBtn, 'URL du calendrier copiée');
            } catch {
                showToast('Copie impossible (navigateur ou permissions).', 'error');
            }
            return;
        }

        const uid = t.getAttribute('data-user-id');
        if (!uid) return;

        if (t.classList.contains('admin-btn-delete')) {
            const ok = await confirmAdminAsync('Supprimer définitivement ce compte ?');
            if (!ok) return;
            const lockKey = takeAdminRowLock(uid, 'delete');
            if (!lockKey) return;
            try {
                try {
                    await planningAdminInvoke('delete_user', { user_id: uid });
                    showToast('Compte supprimé.');
                    await refreshUserList();
                } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), 'error');
                }
            } finally {
                releaseAdminRowLock(lockKey);
            }
        }
        if (t.classList.contains('admin-btn-pw')) {
            const email = t.getAttribute('data-email') || '';
            document.getElementById('admin-pw-user-id').value = uid;
            document.getElementById('admin-pw-target-email').textContent = email;
            document.getElementById('admin-pw-new').value = '';
            document.getElementById('admin-pw-new2').value = '';
            const showCb = document.getElementById('admin-pw-show-plain');
            if (showCb instanceof HTMLInputElement) showCb.checked = false;
            setAdminPwFieldsVisible(false);
            document.getElementById('modal_admin_password')?.showModal();
        }
    });

    document.getElementById('admin-pw-save')?.addEventListener('click', async () => {
        if (adminPasswordSaveInFlight) return;
        adminPasswordSaveInFlight = true;
        const saveBtn = document.getElementById('admin-pw-save');
        if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;

        try {
            const user_id = document.getElementById('admin-pw-user-id')?.value;
            const a = document.getElementById('admin-pw-new')?.value || '';
            const b = document.getElementById('admin-pw-new2')?.value || '';
            if (a !== b) {
                showToast('Les deux mots de passe diffèrent.', 'error');
                return;
            }
            if (a.length < PASSWORD_MIN_LENGTH) {
                showToast(`Au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
                return;
            }
            try {
                await planningAdminInvoke('set_password', { user_id, password: a });
                showToast('Mot de passe défini.');
                document.getElementById('modal_admin_password')?.close();
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        } finally {
            adminPasswordSaveInFlight = false;
            if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
        }
    });
}
