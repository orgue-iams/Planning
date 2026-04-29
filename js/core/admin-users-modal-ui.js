/**
 * Modale "Nouvel utilisateur" (création/invitation + édition ciblée).
 */
import { isAdmin, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_LINES } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { PLANNING_ROLE_OPTIONS, isPlanningRole, normalizePlanningRole } from './planning-roles.js';

let bound = false;
let editUser = null;
let editSnapshot = null;

function formatFrPhone(raw) {
    const digits = String(raw || '').replace(/\D+/g, '').slice(0, 10);
    if (!digits) return '';
    return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

function roleOptions() {
    return PLANNING_ROLE_OPTIONS.map(
        (r) => `<option value="${r.value}">${r.label}</option>`
    ).join('');
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

function setMode(isEdit) {
    document.getElementById('admin-user-modal-title').textContent = isEdit
        ? 'Modifier un utilisateur'
        : 'Nouvel utilisateur';
    document.getElementById('admin-user-modal-subtitle').textContent = isEdit
        ? 'Modifiez les informations du compte, puis sauvegardez.'
        : 'Créer un compte directement ou envoyer une invitation.';
    document.getElementById('admin-user-create-actions')?.classList.toggle('hidden', isEdit);
    document.getElementById('admin-user-edit-actions')?.classList.toggle('hidden', !isEdit);
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

function tryCloseEditModal() {
    const dlg = document.getElementById('modal_users_admin');
    if (!(dlg instanceof HTMLDialogElement)) return;
    if (editUser && hasEditChanges()) {
        if (!confirm('Fermer sans sauvegarder les modifications ?')) return;
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
    dlg.showModal();
}

export function resetAdminUsersUiBindings() {
    bound = false;
    editUser = null;
    editSnapshot = null;
}

export function initAdminUsersUi(currentUser) {
    const show = isBackendAuthConfigured() && isAdmin(currentUser);
    // Gestion des comptes n'est plus un menu direct.
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
        setCreatePasswordVisible(pw?.getAttribute('type') !== 'text');
    });
    document.getElementById('admin-invite-phone')?.addEventListener('blur', (e) => {
        if (e.target instanceof HTMLInputElement) e.target.value = formatFrPhone(e.target.value);
    });
    document.getElementById('admin-create-btn')?.addEventListener('click', () =>
        void createUser().catch((e) => showToast(e?.message || String(e), 'error'))
    );
    document.getElementById('admin-invite-btn')?.addEventListener('click', () =>
        void inviteUser().catch((e) => showToast(e?.message || String(e), 'error'))
    );
    document.getElementById('admin-user-edit-save')?.addEventListener('click', () =>
        void saveEditedUser().catch((e) => showToast(e?.message || String(e), 'error'))
    );
    document.getElementById('admin-user-edit-close')?.addEventListener('click', tryCloseEditModal);
    document.getElementById('admin-user-modal-cancel')?.addEventListener('click', tryCloseEditModal);

    const dlg = document.getElementById('modal_users_admin');
    dlg?.addEventListener('cancel', (e) => {
        if (!editUser || !hasEditChanges()) return;
        e.preventDefault();
        tryCloseEditModal();
    });
}
