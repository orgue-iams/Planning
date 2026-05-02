/**
 * Modale "Nouvel utilisateur" (création/invitation + édition ciblée).
 */
import { isAdmin, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_LINES } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { PLANNING_ROLE_OPTIONS, isPlanningRole, normalizePlanningRole } from './planning-roles.js';

let bound = false;
/** @type {{ id: string; nom: string; prenom: string; email: string; telephone: string; role: string } | null} */
let editUser = null;
let editSnapshot = null;

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

function formatFrPhone(raw) {
    const digits = String(raw || '').replace(/\D+/g, '').slice(0, 10);
    if (!digits) return '';
    return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

function roleOptions() {
    return PLANNING_ROLE_OPTIONS.map((r) => `<option value="${r.value}">${r.label}</option>`).join('');
}

function setCreatePasswordVisible(visible) {
    const pw = document.getElementById('admin-create-password');
    const btn = document.getElementById('admin-create-pw-toggle');
    const iconShow = document.getElementById('admin-create-pw-icon-show');
    const iconHide = document.getElementById('admin-create-pw-icon-hide');
    pw?.setAttribute('type', visible ? 'text' : 'password');
    btn?.setAttribute('aria-pressed', String(visible));
    iconShow?.classList.toggle('hidden', visible);
    iconHide?.classList.toggle('hidden', !visible);
}

function readForm() {
    const nom = String(document.getElementById('admin-invite-nom')?.value || '').trim();
    const prenom = String(document.getElementById('admin-invite-prenom')?.value || '').trim();
    const email = String(document.getElementById('admin-invite-email')?.value || '').trim();
    const telephone = formatFrPhone(document.getElementById('admin-invite-phone')?.value || '');
    const role = normalizePlanningRole(document.getElementById('admin-invite-role')?.value || 'eleve');
    const password = String(document.getElementById('admin-create-password')?.value || '');
    return { nom, prenom, email, telephone, role, password };
}

function applyForm(data) {
    const nom = document.getElementById('admin-invite-nom');
    const prenom = document.getElementById('admin-invite-prenom');
    const email = document.getElementById('admin-invite-email');
    const phone = document.getElementById('admin-invite-phone');
    const role = document.getElementById('admin-invite-role');
    const pass = document.getElementById('admin-create-password');
    if (nom) nom.value = data?.nom || '';
    if (prenom) prenom.value = data?.prenom || '';
    if (email) email.value = data?.email || '';
    if (phone) phone.value = data?.telephone || '';
    if (role) role.value = data?.role || 'eleve';
    if (pass) pass.value = '';
    setCreatePasswordVisible(false);
}

function getCreateMode() {
    const el = document.querySelector('input[name="admin-user-create-mode"]:checked');
    return el instanceof HTMLInputElement && el.value === 'create' ? 'create' : 'invite';
}

function syncCreateModePasswordField() {
    const edit = Boolean(editUser);
    const inviteMode = !edit && getCreateMode() === 'invite';
    const pw = document.getElementById('admin-create-password');
    const toggle = document.getElementById('admin-create-pw-toggle');
    if (pw instanceof HTMLInputElement) {
        pw.disabled = inviteMode;
        if (inviteMode) pw.value = '';
    }
    toggle?.toggleAttribute('disabled', inviteMode);
}

function updatePasswordFieldChrome(isEdit) {
    const pw = document.getElementById('admin-create-password');
    const hint = document.getElementById('admin-password-field-hint');
    if (hint) {
        if (isEdit) {
            hint.textContent = 'Facultatif — laisser vide pour ne pas changer le mot de passe.';
            hint.classList.remove('hidden');
        } else {
            hint.classList.add('hidden');
            hint.textContent = '';
        }
    }
    if (pw instanceof HTMLInputElement) {
        pw.placeholder = isEdit ? '' : getCreateMode() === 'create' ? `Au moins ${PASSWORD_MIN_LENGTH} caractères` : '';
    }
}

function hasEditChanges() {
    if (!editUser || !editSnapshot) return false;
    const cur = readForm();
    return (
        cur.nom !== editSnapshot.nom ||
        cur.prenom !== editSnapshot.prenom ||
        cur.email.toLowerCase() !== editSnapshot.email.toLowerCase() ||
        cur.telephone !== editSnapshot.telephone ||
        cur.role !== editSnapshot.role ||
        cur.password.trim() !== ''
    );
}

function hasCreateFormChanges() {
    const f = readForm();
    const invite = getCreateMode() === 'invite';
    return Boolean(
        f.nom ||
            f.prenom ||
            f.email ||
            f.telephone ||
            (!invite && f.password) ||
            f.role !== 'eleve' ||
            getCreateMode() !== 'invite'
    );
}

function setMode(isEdit) {
    document.getElementById('admin-user-modal-title').textContent = isEdit
        ? 'Modifier un utilisateur'
        : 'Nouvel utilisateur';
    document.getElementById('admin-user-create-mode-wrap')?.classList.toggle('hidden', isEdit);
    const inviteRadio = document.querySelector('input[name="admin-user-create-mode"][value="invite"]');
    const createRadio = document.querySelector('input[name="admin-user-create-mode"][value="create"]');
    if (!isEdit) {
        if (inviteRadio instanceof HTMLInputElement) inviteRadio.checked = true;
        if (createRadio instanceof HTMLInputElement) createRadio.checked = false;
    }
    updatePasswordFieldChrome(isEdit);
    syncCreateModePasswordField();
}

async function createUser() {
    const f = readForm();
    if (!f.nom || !f.prenom) return showToast('Le nom et le prénom sont obligatoires.', 'error');
    if (!f.email.includes('@')) return showToast('E-mail invalide.', 'error');
    if (!isPlanningRole(f.role)) return showToast('Rôle invalide.', 'error');
    if (f.password.length < PASSWORD_MIN_LENGTH) {
        return showToast(`Mot de passe : au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
    }
    await planningAdminInvoke('create_user', {
        email: f.email,
        nom: f.nom,
        prenom: f.prenom,
        telephone: f.telephone,
        role: f.role,
        password: f.password
    });
    showToast('Compte créé.');
    applyForm({ role: 'eleve' });
    const ir = document.querySelector('input[name="admin-user-create-mode"][value="invite"]');
    if (ir instanceof HTMLInputElement) ir.checked = true;
    syncCreateModePasswordField();
    updatePasswordFieldChrome(false);
}

async function inviteUser() {
    const f = readForm();
    if (!f.nom || !f.prenom) return showToast('Le nom et le prénom sont obligatoires.', 'error');
    if (!f.email.includes('@')) return showToast('E-mail invalide.', 'error');
    if (!isPlanningRole(f.role)) return showToast('Rôle invalide.', 'error');
    await planningAdminInvoke('invite', {
        email: f.email,
        nom: f.nom,
        prenom: f.prenom,
        telephone: f.telephone,
        role: f.role,
        redirect_to: new URL('.', window.location.href).href
    });
    showToast('Invitation envoyée.');
    applyForm({ role: 'eleve' });
}

async function saveEditedUser() {
    if (!editUser) return;
    const f = readForm();
    if (!f.nom || !f.prenom) return showToast('Le nom et le prénom sont obligatoires.', 'error');
    if (!f.email.includes('@')) return showToast('E-mail invalide.', 'error');
    if (!isPlanningRole(f.role)) return showToast('Rôle invalide.', 'error');
    const initial = editSnapshot || {};
    if (f.email.toLowerCase() !== String(initial.email || '').toLowerCase()) {
        await planningAdminInvoke('update_user_email', { user_id: editUser.id, email: f.email.toLowerCase() });
    }
    if (f.nom !== initial.nom || f.prenom !== initial.prenom || f.telephone !== initial.telephone) {
        await planningAdminInvoke('update_user_nom_prenom', {
            user_id: editUser.id,
            nom: f.nom,
            prenom: f.prenom,
            telephone: f.telephone
        });
    }
    if (f.role !== initial.role) {
        await planningAdminInvoke('update_role', { user_id: editUser.id, role: f.role });
    }
    if (f.password.trim() !== '') {
        if (f.password.length < PASSWORD_MIN_LENGTH) {
            return showToast(`Mot de passe : au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
        }
        await planningAdminInvoke('set_password', { user_id: editUser.id, password: f.password });
    }
    showToast('Utilisateur mis à jour.');
    editSnapshot = { ...f, password: '' };
    applyForm(editSnapshot);
}

async function saveOrCreateUser() {
    if (editUser) return saveEditedUser();
    if (getCreateMode() === 'create') return createUser();
    return inviteUser();
}

async function tryCloseUserModal() {
    const dlg = document.getElementById('modal_users_admin');
    if (!(dlg instanceof HTMLDialogElement)) return;
    const dirty = editUser ? hasEditChanges() : hasCreateFormChanges();
    if (dirty) {
        const ok = await confirmAdminAsync('Abandonner les modifications non enregistrées ?');
        if (!ok) return;
    }
    dlg.close();
}

export function openAdminUserModalForCreate() {
    const dlg = document.getElementById('modal_users_admin');
    if (!(dlg instanceof HTMLDialogElement)) return;
    editUser = null;
    editSnapshot = null;
    setMode(false);
    applyForm({ role: 'eleve' });
    dlg.showModal();
}

export function openAdminUserModalForEdit(userRow) {
    const dlg = document.getElementById('modal_users_admin');
    if (!(dlg instanceof HTMLDialogElement)) return;
    editUser = {
        id: String(userRow.id || ''),
        nom: String(userRow.nom || '').trim(),
        prenom: String(userRow.prenom || '').trim(),
        email: String(userRow.email || '').trim(),
        telephone: formatFrPhone(String(userRow.telephone || '').trim()),
        role: normalizePlanningRole(userRow.role || 'eleve')
    };
    editSnapshot = { ...editUser, password: '' };
    setMode(true);
    applyForm(editSnapshot);
    syncCreateModePasswordField();
    dlg.showModal();
}

export function resetAdminUsersUiBindings() {
    bound = false;
    editUser = null;
    editSnapshot = null;
}

export function initAdminUsersUi(currentUser) {
    const show = isBackendAuthConfigured() && isAdmin(currentUser);
    document.getElementById('menu-item-users-admin-wrap')?.classList.add('hidden');
    if (!show || bound) return;
    bound = true;

    const roleSel = document.getElementById('admin-invite-role');
    if (roleSel && !roleSel.options.length) roleSel.innerHTML = roleOptions();
    const policy = document.getElementById('admin-create-pw-policy');
    if (policy) {
        policy.replaceChildren();
        for (const line of PASSWORD_POLICY_LINES) {
            const li = document.createElement('li');
            li.textContent = line;
            policy.appendChild(li);
        }
    }

    document.getElementById('admin-create-pw-toggle')?.addEventListener('click', () => {
        const pw = document.getElementById('admin-create-password');
        if (pw instanceof HTMLInputElement && pw.disabled) return;
        setCreatePasswordVisible(pw?.getAttribute('type') !== 'text');
    });
    document.getElementById('admin-invite-phone')?.addEventListener('blur', (e) => {
        if (e.target instanceof HTMLInputElement) e.target.value = formatFrPhone(e.target.value);
    });

    document.querySelectorAll('input[name="admin-user-create-mode"]').forEach((r) => {
        r.addEventListener('change', () => {
            updatePasswordFieldChrome(Boolean(editUser));
            syncCreateModePasswordField();
        });
    });

    document.getElementById('admin-user-modal-save')?.addEventListener('click', () =>
        void saveOrCreateUser().catch((e) => showToast(e?.message || String(e), 'error'))
    );
    document.getElementById('admin-user-modal-cancel')?.addEventListener('click', () =>
        void tryCloseUserModal()
    );

    const dlg = document.getElementById('modal_users_admin');
    dlg?.addEventListener('cancel', (e) => {
        const dirty = editUser ? hasEditChanges() : hasCreateFormChanges();
        if (!dirty) return;
        e.preventDefault();
        void tryCloseUserModal();
    });
}
