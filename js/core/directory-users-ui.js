/**
 * Annuaire interne : RPC planning_directory_users (élèves) ; admin/prof voient tout et éditent dans le tiroir route.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import {
    isLikelySessionErrorMessage,
    notifySessionInvalid,
    isAdmin,
    isProf,
    PASSWORD_MIN_LENGTH
} from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';
import { planningAdminInvoke } from './admin-api.js';
import { isPlanningRole } from './planning-roles.js';
import {
    openPlanningRouteFromDrawer,
    setPlanningRouteBackHandler,
    updatePlanningRouteDialog
} from '../utils/planning-route-dialog.js';
import { normalizePlanningRole, PLANNING_ROLE_OPTIONS } from './planning-roles.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';

let bound = false;
/** @type {object | null} */
let editingUser = null;
/** @type {object | null} */
let editSnapshot = null;
/** @type {object[] | null} */
let privilegedUsersCache = null;

const DELETE_USER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m2 0H7m2-3h6a1 1 0 011 1v1H8V5a1 1 0 011-1z"/></svg>';

function directoryRoleCardClass(role) {
    const key = normalizePlanningRole(role);
    if (key === 'admin') return 'directory-admin-user-card--role-admin';
    if (key === 'prof') return 'directory-admin-user-card--role-prof';
    return 'directory-admin-user-card--role-eleve';
}

/** @returns {string[]} lignes contact droite (email, tél., planning) */
function directoryUserContactLines(r) {
    const email = String(r?.email || '').trim();
    const phone = formatFrPhone(String(r?.telephone || '').trim());
    const planning = String(r?.personal_calendar_label || r?.calendar_label || '').trim();
    const shown = new Set();
    const lines = [];
    if (email) {
        lines.push(email);
        shown.add('email');
    } else if (phone) {
        lines.push(phone);
        shown.add('phone');
    } else if (planning) {
        lines.push(planning);
        shown.add('planning');
    }
    if (!shown.has('phone') && phone) {
        lines.push(phone);
        shown.add('phone');
    } else if (!shown.has('planning') && planning) {
        lines.push(planning);
        shown.add('planning');
    }
    if (!shown.has('planning') && planning) lines.push(planning);
    return lines;
}

/** @param {object} r @returns {HTMLElement} */
function buildDirectoryContactColumn(r) {
    const col = document.createElement('div');
    col.className =
        'directory-user-card__contact text-right min-w-0 flex flex-col gap-0.5 self-stretch justify-center py-0.5';
    for (const line of directoryUserContactLines(r)) {
        if (line.includes('@')) {
            const a = document.createElement('a');
            a.href = `mailto:${encodeURIComponent(line)}`;
            a.className =
                'directory-user-mailto-link text-[11px] sm:text-xs font-medium text-sky-700 hover:underline break-all leading-snug';
            a.textContent = line;
            col.appendChild(a);
        } else {
            const p = document.createElement('p');
            p.className =
                'text-[11px] sm:text-xs text-slate-700 dark:text-slate-200 m-0 break-words leading-snug';
            p.style.overflowWrap = 'anywhere';
            p.textContent = line;
            col.appendChild(p);
        }
    }
    return col;
}

function roleLabel(role) {
    const key = normalizePlanningRole(role);
    return PLANNING_ROLE_OPTIONS.find((o) => o.value === key)?.label ?? key;
}

function confirmDirectoryAsync(message) {
    return new Promise((resolve) => {
        const dlg = document.getElementById('modal_admin_confirm');
        const msg = document.getElementById('admin-confirm-message');
        const btnOk = document.getElementById('admin-confirm-ok');
        const btnCancel = document.getElementById('admin-confirm-cancel');
        if (!dlg || !msg || !btnOk || !btnCancel) {
            resolve(window.confirm(message));
            return;
        }
        msg.textContent = message;
        const cleanup = (v) => {
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            dlg.removeEventListener('cancel', onCancel);
            dlg.close();
            resolve(v);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        dlg.addEventListener('cancel', onCancel, { once: true });
        dlg.showModal();
        focusPlanningDialogRoot(dlg instanceof HTMLDialogElement ? dlg : null);
    });
}

function formatFrPhone(raw) {
    const digits = String(raw || '').replace(/\D+/g, '').slice(0, 10);
    if (!digits) return '';
    return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
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

function isDirectoryPrivileged(u) {
    return isAdmin(u) || isProf(u);
}

/**
 * Carte admin/prof : gauche (nom + rôle), droite (tél. + agenda), suppression optionnelle.
 * @param {object} r
 * @param {{ canOpen: boolean; canDelete: boolean }} opts
 */
function buildPrivilegedUserCard(r, opts) {
    const card = document.createElement('div');
    const roleKey = normalizePlanningRole(r.profile_role || r.role);
    const withDelete = Boolean(opts.canDelete);
    card.className =
        `directory-admin-user-card directory-admin-user-card--layout ${directoryRoleCardClass(roleKey)} ${withDelete ? 'directory-admin-user-card--with-delete' : ''} py-2.5 px-3 min-w-0 rounded-xl border`;
    card.dataset.userJson = JSON.stringify(r);

    const identity = document.createElement('div');
    identity.className =
        'directory-user-card__identity min-w-0 self-stretch flex flex-col justify-center pr-2';
    const nameP = document.createElement('p');
    nameP.className =
        'font-semibold text-slate-900 dark:text-slate-100 leading-snug m-0 break-words text-[13px]';
    nameP.style.overflowWrap = 'anywhere';
    nameP.textContent = directoryDisplayName(r);
    const roleP = document.createElement('p');
    roleP.className = 'directory-user-card__role text-[11px] sm:text-xs leading-snug m-0 mt-0.5';
    roleP.textContent = roleLabel(r.profile_role || r.role);
    identity.appendChild(nameP);
    identity.appendChild(roleP);
    card.appendChild(identity);

    const contact = buildDirectoryContactColumn(r);
    if (contact.childElementCount) card.appendChild(contact);

    const openEdit = () => {
        try {
            openDirectoryUserEdit(JSON.parse(card.dataset.userJson || '{}'));
        } catch {
            showToast('Impossible d’ouvrir la fiche utilisateur.', 'error');
        }
    };

    if (opts.canDelete) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'directory-user-delete-btn';
        del.setAttribute('aria-label', `Supprimer ${directoryDisplayName(r)}`);
        del.title = 'Supprimer';
        del.innerHTML = DELETE_USER_SVG;
        del.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            void deleteDirectoryUser(String(r.id || ''));
        });
        card.appendChild(del);
    }

    if (opts.canOpen) {
        const bindOpen = (el) => {
            el.classList.add('cursor-pointer');
            el.setAttribute('role', 'button');
            el.tabIndex = 0;
            el.addEventListener('click', (e) => {
                if (e.target instanceof Element && e.target.closest('a')) return;
                openEdit();
            });
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openEdit();
                }
            });
        };
        bindOpen(identity);
        if (contact.childElementCount) bindOpen(contact);
    }

    return card;
}

/** Annuaire lecture seule (élèves) : sections + cartes 2 lignes. */
function renderDirectoryUnified(container, admins, profs, eleves) {
    if (!container) return;
    container.replaceChildren();

    const sections = [
        { title: 'Administrateurs', rows: admins },
        { title: 'Professeurs', rows: profs },
        { title: 'Élèves', rows: eleves }
    ];

    const root = document.createElement('div');
    root.className = 'directory-users-stack min-w-0 text-[12px] sm:text-[13px] space-y-2';

    let firstSection = true;
    for (const { title, rows } of sections) {
        const block = document.createElement('div');
        if (!firstSection) block.className = 'mt-4 pt-3 border-t border-slate-200 dark:border-slate-600';
        firstSection = false;

        const head = document.createElement('p');
        head.className =
            'text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300 mb-1 m-0';
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
                'directory-readonly-user-item directory-admin-user-card--layout py-3 px-3 min-w-0 rounded-xl border border-slate-200 bg-slate-50/80 dark:border-slate-600 dark:bg-slate-800/70';

            const identity = document.createElement('div');
            identity.className = 'directory-user-card__identity min-w-0 self-stretch flex flex-col justify-center pr-2';
            const nameEl = document.createElement('p');
            nameEl.className =
                'font-semibold text-slate-900 dark:text-slate-100 leading-snug m-0 break-words';
            nameEl.style.overflowWrap = 'anywhere';
            nameEl.textContent = directoryDisplayName(r);
            identity.appendChild(nameEl);
            item.appendChild(identity);
            const contact = buildDirectoryContactColumn(r);
            if (contact.childElementCount) item.appendChild(contact);
            list.appendChild(item);
        }
        block.appendChild(list);
        root.appendChild(block);
    }

    container.appendChild(root);
}

function renderPrivilegedDirectoryCards(users) {
    const host = document.getElementById('directory-admin-users-table');
    if (!host) return;
    host.replaceChildren();

    const root = document.createElement('div');
    root.className = 'directory-users-stack space-y-1.5 min-w-0';

    const sorted = [...users].sort((a, b) =>
        `${String(a.nom || '')} ${String(a.prenom || '')}`.localeCompare(
            `${String(b.nom || '')} ${String(b.prenom || '')}`,
            'fr'
        )
    );

    const sessionUser = getPlanningSessionUser();
    const adminUser = isAdmin(sessionUser);
    for (const r of sorted) {
        root.appendChild(
            buildPrivilegedUserCard(r, { canOpen: adminUser, canDelete: adminUser })
        );
    }

    host.appendChild(root);
}

function mapRpcRowToPrivileged(r) {
    return {
        id: r.user_id,
        nom: r.nom,
        prenom: r.prenom,
        display_name: r.display_name,
        email: r.email,
        telephone: r.telephone,
        personal_calendar_label: r.calendar_label,
        personal_google_calendar_id: '',
        profile_role: r.role
    };
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

    const u = getPlanningSessionUser();
    if (!u?.id || !isBackendAuthConfigured()) {
        if (status) status.textContent = 'Connectez-vous pour voir l’annuaire.';
        unified.replaceChildren();
        return;
    }

    if (status) status.textContent = 'Chargement…';
    const sb = getSupabaseClient();
    if (!sb) {
        if (status) status.textContent = 'Session indisponible.';
        unified.replaceChildren();
        return;
    }

    const { data, error } = await sb.rpc('planning_directory_users');
    if (error) {
        if (isLikelySessionErrorMessage(error)) {
            notifySessionInvalid(String(error.message || 'Session expirée. Reconnectez-vous.'));
        } else if (status) {
            status.textContent = error.message || 'Erreur annuaire.';
        }
        unified.replaceChildren();
        return;
    }

    const rows = (Array.isArray(data) ? data : []).filter(isDirectoryUserActive);
    const admins = rows.filter((r) => String(r.role || '').toLowerCase() === 'admin');
    const profs = rows.filter((r) => String(r.role || '').toLowerCase() === 'prof');
    const eleves = rows.filter((r) => String(r.role || '').toLowerCase() === 'eleve');
    renderDirectoryUnified(unified, admins, profs, eleves);
    if (status) status.textContent = '';
}

async function loadPrivilegedDirectoryIntoModal() {
    const status = document.getElementById('directory-users-status');
    const tableWrap = document.getElementById('directory-admin-users-wrap');
    const unified = document.getElementById('directory-readonly-unified');
    unified?.classList.add('hidden');
    tableWrap?.classList.remove('hidden');
    hideLegacyDirectorySections(
        document.getElementById('directory-section-admins'),
        document.getElementById('directory-section-profs'),
        document.getElementById('directory-section-eleves')
    );

    const u = getPlanningSessionUser();
    const adminUser = isAdmin(u);
    if (status) status.textContent = 'Chargement…';

    try {
        let users = [];
        if (adminUser) {
            const res = await planningAdminInvoke('list_users', {});
            users = (Array.isArray(res?.users) ? res.users : []).filter(isDirectoryUserActive);
        } else {
            const sb = getSupabaseClient();
            if (!sb) throw new Error('Session indisponible.');
            const { data, error } = await sb.rpc('planning_directory_users');
            if (error) throw error;
            users = (Array.isArray(data) ? data : [])
                .filter(isDirectoryUserActive)
                .map(mapRpcRowToPrivileged);
        }
        privilegedUsersCache = users;
        renderPrivilegedDirectoryCards(users);
        if (status) status.textContent = '';
    } catch (e) {
        if (!isLikelySessionErrorMessage(e) && status) {
            status.textContent = String(e?.message || e || 'Erreur chargement.');
        }
    }
}

function showDirectoryListPanel() {
    document.getElementById('directory-users-list-panel')?.classList.remove('hidden');
    const edit = document.getElementById('directory-user-edit-panel');
    edit?.classList.add('hidden');
    edit?.setAttribute('aria-hidden', 'true');
    const create = document.getElementById('directory-user-create-panel');
    create?.classList.add('hidden');
    create?.setAttribute('aria-hidden', 'true');
    editingUser = null;
    editSnapshot = null;
    setPlanningRouteBackHandler('modal_directory_users', () => {
        document.getElementById('modal_directory_users')?.close();
    });
    updatePlanningRouteDialog('modal_directory_users', 'Utilisateurs', 'Menu');
}

function getDirectoryCreateMode() {
    const el = document.querySelector('input[name="directory-user-create-mode"]:checked');
    return el instanceof HTMLInputElement && el.value === 'create' ? 'create' : 'invite';
}

function syncDirectoryCreatePasswordField() {
    const invite = getDirectoryCreateMode() === 'invite';
    const pw = document.getElementById('directory-create-password');
    if (pw instanceof HTMLInputElement) {
        pw.disabled = invite;
        if (invite) pw.value = '';
    }
}

function readDirectoryCreateForm() {
    return {
        nom: String(document.getElementById('directory-create-nom')?.value || '').trim(),
        prenom: String(document.getElementById('directory-create-prenom')?.value || '').trim(),
        email: String(document.getElementById('directory-create-email')?.value || '').trim(),
        telephone: formatFrPhone(document.getElementById('directory-create-phone')?.value || ''),
        role: normalizePlanningRole(document.getElementById('directory-create-role')?.value || 'eleve'),
        password: String(document.getElementById('directory-create-password')?.value || '')
    };
}

function resetDirectoryCreateForm() {
    for (const id of [
        'directory-create-nom',
        'directory-create-prenom',
        'directory-create-email',
        'directory-create-phone',
        'directory-create-password'
    ]) {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement) el.value = '';
    }
    const role = document.getElementById('directory-create-role');
    if (role instanceof HTMLSelectElement) role.value = 'eleve';
    const ir = document.querySelector('input[name="directory-user-create-mode"][value="invite"]');
    if (ir instanceof HTMLInputElement) ir.checked = true;
    syncDirectoryCreatePasswordField();
}

async function submitDirectoryCreateUser() {
    const f = readDirectoryCreateForm();
    if (!f.nom || !f.prenom) return showToast('Le nom et le prénom sont obligatoires.', 'error');
    if (!f.email.includes('@')) return showToast('E-mail invalide.', 'error');
    if (!isPlanningRole(f.role)) return showToast('Rôle invalide.', 'error');
    try {
        if (getDirectoryCreateMode() === 'create') {
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
        } else {
            await planningAdminInvoke('invite', {
                email: f.email,
                nom: f.nom,
                prenom: f.prenom,
                telephone: f.telephone,
                role: f.role,
                redirect_to: new URL('.', window.location.href).href
            });
        }
        resetDirectoryCreateForm();
        showDirectoryListPanel();
        privilegedUsersCache = null;
        await loadPrivilegedDirectoryIntoModal();
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

function openDirectoryUserCreate() {
    if (!isAdmin(getPlanningSessionUser())) return;
    document.getElementById('directory-users-list-panel')?.classList.add('hidden');
    document.getElementById('directory-user-edit-panel')?.classList.add('hidden');
    const create = document.getElementById('directory-user-create-panel');
    create?.classList.remove('hidden');
    create?.setAttribute('aria-hidden', 'false');
    resetDirectoryCreateForm();
    setPlanningRouteBackHandler('modal_directory_users', () => {
        showDirectoryListPanel();
    });
    updatePlanningRouteDialog(
        'modal_directory_users',
        'Utilisateurs / Nouvel utilisateur',
        'Utilisateurs'
    );
}

function readDirectoryEditForm() {
    return {
        nom: String(document.getElementById('directory-edit-nom')?.value || '').trim(),
        prenom: String(document.getElementById('directory-edit-prenom')?.value || '').trim(),
        email: String(document.getElementById('directory-edit-email')?.value || '').trim(),
        telephone: formatFrPhone(document.getElementById('directory-edit-phone')?.value || ''),
        role: normalizePlanningRole(document.getElementById('directory-edit-role')?.value || 'eleve'),
        password: String(document.getElementById('directory-edit-password')?.value || '')
    };
}

async function saveDirectoryField(field) {
    if (!editingUser?.id || !editSnapshot) return;
    const uid = editingUser.id;
    const adminUser = isAdmin(getPlanningSessionUser());
    const f = readDirectoryEditForm();

    try {
        if (field === 'identity' && (f.nom !== editSnapshot.nom || f.prenom !== editSnapshot.prenom || f.telephone !== editSnapshot.telephone)) {
            await planningAdminInvoke('update_user_nom_prenom', {
                user_id: uid,
                nom: f.nom,
                prenom: f.prenom,
                telephone: f.telephone
            });
            editSnapshot.nom = f.nom;
            editSnapshot.prenom = f.prenom;
            editSnapshot.telephone = f.telephone;
            privilegedUsersCache = null;
        }
        if (adminUser && field === 'email' && f.email !== editSnapshot.email) {
            if (!f.email.includes('@')) {
                showToast('E-mail invalide.', 'error');
                return;
            }
            await planningAdminInvoke('update_user_email', { user_id: uid, email: f.email });
            editSnapshot.email = f.email;
            privilegedUsersCache = null;
        }
        if (adminUser && field === 'role' && f.role !== editSnapshot.role) {
            await planningAdminInvoke('update_role', { user_id: uid, role: f.role });
            editSnapshot.role = f.role;
            privilegedUsersCache = null;
        }
        if (adminUser && field === 'password' && f.password) {
            if (f.password.length < PASSWORD_MIN_LENGTH) {
                showToast(`Mot de passe : au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
                return;
            }
            await planningAdminInvoke('set_password', { user_id: uid, password: f.password });
            const pw = document.getElementById('directory-edit-password');
            if (pw instanceof HTMLInputElement) pw.value = '';
        }
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

function openDirectoryUserEdit(userRow) {
    const u = getPlanningSessionUser();
    if (!isDirectoryPrivileged(u)) return;

    editingUser = userRow;
    const role = normalizePlanningRole(userRow.profile_role || userRow.role || 'eleve');
    editSnapshot = {
        nom: String(userRow.nom || '').trim(),
        prenom: String(userRow.prenom || '').trim(),
        email: String(userRow.email || '').trim(),
        telephone: formatFrPhone(String(userRow.telephone || '').trim()),
        role
    };

    const adminUser = isAdmin(u);
    document.getElementById('directory-users-list-panel')?.classList.add('hidden');
    const editPanel = document.getElementById('directory-user-edit-panel');
    editPanel?.classList.remove('hidden');
    editPanel?.setAttribute('aria-hidden', 'false');

    const nom = document.getElementById('directory-edit-nom');
    const prenom = document.getElementById('directory-edit-prenom');
    const email = document.getElementById('directory-edit-email');
    const phone = document.getElementById('directory-edit-phone');
    const roleEl = document.getElementById('directory-edit-role');
    const pw = document.getElementById('directory-edit-password');
    if (nom) nom.value = editSnapshot.nom;
    if (prenom) prenom.value = editSnapshot.prenom;
    if (email) {
        email.value = editSnapshot.email;
        email.readOnly = !adminUser;
        email.classList.toggle('opacity-70', !adminUser);
    }
    if (phone) phone.value = editSnapshot.telephone;
    if (roleEl) roleEl.value = editSnapshot.role;
    if (pw) pw.value = '';
    document.getElementById('directory-edit-role-wrap')?.classList.toggle('hidden', !adminUser);
    document.getElementById('directory-edit-password-wrap')?.classList.toggle('hidden', !adminUser);

    const calLabel = String(
        userRow.personal_calendar_label || userRow.calendar_label || ''
    ).trim();
    const agendaEl = document.getElementById('directory-edit-agenda-readonly');
    if (agendaEl) {
        agendaEl.innerHTML = '';
        const dt = document.createElement('span');
        dt.className = 'font-semibold text-slate-600 dark:text-slate-300';
        dt.textContent = 'Planning perso. ';
        const dd = document.createElement('span');
        dd.textContent = calLabel || '— (aucun agenda assigné)';
        agendaEl.append(dt, dd);
    }
    document.getElementById('directory-edit-save-hint')?.remove();

    const titleName = directoryDisplayName(userRow);
    setPlanningRouteBackHandler('modal_directory_users', () => {
        showDirectoryListPanel();
        void reloadDirectoryAfterEdit();
    });
    updatePlanningRouteDialog('modal_directory_users', `Utilisateurs / ${titleName}`, 'Utilisateurs');
}

async function reloadDirectoryAfterEdit() {
    const u = getPlanningSessionUser();
    if (isDirectoryPrivileged(u)) await loadPrivilegedDirectoryIntoModal();
    else await loadDirectoryIntoModal();
}

async function deleteDirectoryUser(userId) {
    const uid = String(userId || '').trim();
    if (!uid || !isAdmin(getPlanningSessionUser())) return;
    const selfId = getPlanningSessionUser()?.id;
    if (selfId && uid === selfId) {
        showToast('Vous ne pouvez pas supprimer votre propre compte.', 'error');
        return;
    }
    const ok = await confirmDirectoryAsync(
        'Supprimer définitivement ce compte ? Cette action est irréversible.'
    );
    if (!ok) return;
    try {
        await planningAdminInvoke('delete_user', { user_id: uid });
        privilegedUsersCache = null;
        if (document.getElementById('modal_directory_users')?.open) {
            await loadPrivilegedDirectoryIntoModal();
        }
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

export function resetDirectoryUsersUiBindings() {
    bound = false;
    editingUser = null;
    editSnapshot = null;
    privilegedUsersCache = null;
}

export function initDirectoryUsersUi() {
    if (bound) return;
    bound = true;

    document.getElementById('menu-item-directory')?.addEventListener('click', (e) => {
        e.preventDefault();
        const dlg = document.getElementById('modal_directory_users');
        if (!dlg) {
            showToast('Fenêtre annuaire indisponible. Rechargez la page.', 'error');
            return;
        }
        showDirectoryListPanel();
        const u = getPlanningSessionUser();
        const privileged = isDirectoryPrivileged(u);
        document.getElementById('directory-add-user-wrap')?.classList.toggle('hidden', !isAdmin(u));
        const status = document.getElementById('directory-users-status');
        if (!openPlanningRouteFromDrawer('modal_directory_users', 'Utilisateurs', 'Menu')) {
            return;
        }
        if (privileged && privilegedUsersCache?.length) {
            const tableWrap = document.getElementById('directory-admin-users-wrap');
            document.getElementById('directory-readonly-unified')?.classList.add('hidden');
            tableWrap?.classList.remove('hidden');
            renderPrivilegedDirectoryCards(privilegedUsersCache);
            if (status) status.textContent = '';
            void loadPrivilegedDirectoryIntoModal();
        } else {
            if (status) status.textContent = 'Chargement…';
            void (privileged ? loadPrivilegedDirectoryIntoModal() : loadDirectoryIntoModal());
        }
    });

    document.getElementById('directory-add-user-btn')?.addEventListener('click', () => {
        openDirectoryUserCreate();
    });

    document.querySelectorAll('input[name="directory-user-create-mode"]').forEach((el) => {
        el.addEventListener('change', () => syncDirectoryCreatePasswordField());
    });
    document.getElementById('directory-create-submit')?.addEventListener('click', () => {
        void submitDirectoryCreateUser();
    });

    const bindBlur = (id, field) => {
        document.getElementById(id)?.addEventListener('blur', () => void saveDirectoryField(field));
    };
    bindBlur('directory-edit-nom', 'identity');
    bindBlur('directory-edit-prenom', 'identity');
    bindBlur('directory-edit-phone', 'identity');
    bindBlur('directory-edit-email', 'email');
    bindBlur('directory-edit-password', 'password');
    document.getElementById('directory-edit-role')?.addEventListener('change', () =>
        void saveDirectoryField('role')
    );

    document.getElementById('modal_directory_users')?.addEventListener('close', () => {
        showDirectoryListPanel();
    });
}
