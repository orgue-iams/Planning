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
    planningRouteTitle,
    pushPlanningRouteLevel,
    popPlanningRouteLevel,
    setPlanningRouteBackHandler
} from '../utils/planning-route-dialog.js';
import { normalizePlanningRole, PLANNING_ROLE_OPTIONS } from './planning-roles.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';
import { createPlanningIconDeleteButton } from '../utils/planning-delete-btn.js';

let bound = false;
/** @type {object | null} */
let editingUser = null;
/** @type {object | null} */
let editSnapshot = null;
/** @type {object[] | null} */
let privilegedUsersCache = null;

const DIRECTORY_PW_MASK = '********';
let directoryPasswordMasked = false;

const DIRECTORY_USER_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>';

const DIRECTORY_CALENDAR_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>';

function directoryRoleCardClass(role) {
    const key = normalizePlanningRole(role);
    if (key === 'admin') return 'directory-admin-user-card--role-admin';
    if (key === 'prof') return 'directory-admin-user-card--role-prof';
    return 'directory-admin-user-card--role-eleve';
}

/** @returns {string[]} lignes contact (email, tél. — pas l’agenda, affiché à part). */
function directoryUserContactLines(r) {
    const email = String(r?.email || '').trim();
    const phone = formatFrPhone(String(r?.telephone || '').trim());
    const lines = [];
    if (email) lines.push(email);
    if (phone) lines.push(phone);
    return lines;
}

function directoryUserAgendaLabel(r) {
    if (!isAdmin(getPlanningSessionUser())) return '';
    return String(r?.personal_calendar_label || r?.calendar_label || '').trim();
}

/** @param {object} r @param {string} roleKey @returns {HTMLElement} */
function buildDirectoryContactColumn(r, roleKey) {
    const col = document.createElement('div');
    col.className =
        'directory-user-card__contact text-left min-w-0 flex flex-col gap-0.5 self-stretch justify-center py-0.5';
    for (const line of directoryUserContactLines(r)) {
        if (line.includes('@')) {
            const a = document.createElement('a');
            a.href = `mailto:${encodeURIComponent(line)}`;
            a.className =
                'directory-user-mailto-link text-[11px] sm:text-xs font-medium text-slate-900 hover:underline break-all leading-snug';
            a.textContent = line;
            col.appendChild(a);
        } else {
            const p = document.createElement('p');
            p.className =
                'text-[11px] sm:text-xs text-slate-900 m-0 break-words leading-snug';
            p.style.overflowWrap = 'anywhere';
            p.textContent = line;
            col.appendChild(p);
        }
    }
    const agenda = directoryUserAgendaLabel(r);
    if (agenda) {
        const row = document.createElement('div');
        row.className =
            'directory-user-card__agenda-row flex items-center justify-start gap-1.5 min-w-0';
        const icon = document.createElement('span');
        icon.className = `directory-user-card__avatar directory-user-card__avatar--${roleKey} directory-user-card__agenda-icon shrink-0`;
        icon.innerHTML = DIRECTORY_CALENDAR_ICON_SVG;
        const lab = document.createElement('p');
        lab.className =
            'directory-user-card__agenda text-[11px] sm:text-xs font-semibold text-slate-800 m-0 break-words leading-snug';
        lab.textContent = agenda;
        row.appendChild(icon);
        row.appendChild(lab);
        col.appendChild(row);
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

/** Prénom et nom sur une ligne (petites capitales via `.directory-user-card__name`). */
function fillDirectoryUserNameElement(el, r) {
    if (!(el instanceof HTMLElement)) return;
    const p = String(r?.prenom || '').trim();
    const n = String(r?.nom || '').trim();
    el.replaceChildren();
    if (p) {
        const sp = document.createElement('span');
        sp.className = 'directory-user-card__prenom';
        sp.textContent = p;
        el.appendChild(sp);
        if (n) el.appendChild(document.createTextNode(' '));
    }
    if (n) {
        const sn = document.createElement('span');
        sn.className = 'directory-user-card__nom';
        sn.textContent = n;
        el.appendChild(sn);
    }
    if (!p && !n) {
        el.textContent = String(r?.display_name || '').trim() || '—';
    }
}

function isDirectoryPrivileged(u) {
    return isAdmin(u) || isProf(u);
}

/**
 * Carte admin/prof : identité | contact (3 lignes) | suppression.
 * @param {object} r
 * @param {{ canOpen: boolean; canDelete: boolean }} opts
 */
function buildPrivilegedUserCard(r, opts) {
    const card = document.createElement('div');
    const roleKey = normalizePlanningRole(r.profile_role || r.role);
    const withDelete = Boolean(opts.canDelete);
    card.className =
        `directory-admin-user-card directory-admin-user-card--layout-v3${withDelete ? ' directory-admin-user-card--with-delete' : ''} ${directoryRoleCardClass(roleKey)} py-2.5 px-3 min-w-0 rounded-xl border`;
    card.dataset.userJson = JSON.stringify(r);

    const identity = document.createElement('div');
    identity.className =
        'directory-user-card__identity min-w-0 flex flex-row items-start gap-2';

    const avatar = document.createElement('span');
    avatar.className = `directory-user-card__avatar directory-user-card__avatar--${roleKey} shrink-0`;
    avatar.innerHTML = DIRECTORY_USER_ICON_SVG;

    const identityText = document.createElement('div');
    identityText.className = 'min-w-0 flex-1 flex flex-col justify-center pt-0.5';
    const nameP = document.createElement('p');
    nameP.className =
        'directory-user-card__name font-semibold text-slate-900 leading-snug m-0 text-[13px]';
    fillDirectoryUserNameElement(nameP, r);
    const roleP = document.createElement('p');
    roleP.className =
        'directory-user-card__role font-bold text-[11px] sm:text-xs leading-snug m-0 mt-0.5 text-slate-700';
    roleP.textContent = roleLabel(r.profile_role || r.role);
    identityText.appendChild(nameP);
    identityText.appendChild(roleP);
    identity.appendChild(avatar);
    identity.appendChild(identityText);
    card.appendChild(identity);

    const contact = buildDirectoryContactColumn(r, roleKey);
    card.appendChild(contact);

    if (withDelete) {
        const actions = document.createElement('div');
        actions.className = 'directory-user-card__actions';
        actions.appendChild(
            createPlanningIconDeleteButton({
                ariaLabel: `Supprimer ${directoryDisplayName(r)}`,
                title: 'Supprimer',
                onClick: () => void deleteDirectoryUser(String(r.id || ''))
            })
        );
        card.appendChild(actions);
    }

    const openEdit = () => {
        try {
            openDirectoryUserEdit(JSON.parse(card.dataset.userJson || '{}'));
        } catch {
            showToast('Impossible d’ouvrir la fiche utilisateur.', 'error');
        }
    };

    if (opts.canOpen) {
        const bindOpen = (el) => {
            el.classList.add('cursor-pointer');
            el.setAttribute('role', 'button');
            el.tabIndex = 0;
            el.addEventListener('click', (e) => {
                if (e.target instanceof Element && e.target.closest('button, a')) return;
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
            const roleKey = normalizePlanningRole(r.profile_role || r.role);
            item.className = `directory-readonly-user-item directory-admin-user-card directory-admin-user-card--layout-v3 ${directoryRoleCardClass(roleKey)} py-2.5 px-3 min-w-0 rounded-xl border`;

            const identity = document.createElement('div');
            identity.className =
                'directory-user-card__identity min-w-0 flex flex-row items-start gap-2';
            const avatar = document.createElement('span');
            avatar.className = `directory-user-card__avatar directory-user-card__avatar--${roleKey} shrink-0`;
            avatar.innerHTML = DIRECTORY_USER_ICON_SVG;
            const identityText = document.createElement('div');
            identityText.className = 'min-w-0 flex-1 flex flex-col justify-center pt-0.5';
            const nameEl = document.createElement('p');
            nameEl.className =
                'directory-user-card__name font-semibold text-slate-900 leading-snug m-0 text-[13px]';
            fillDirectoryUserNameElement(nameEl, r);
            const roleP = document.createElement('p');
            roleP.className =
                'directory-user-card__role font-bold text-[11px] sm:text-xs leading-snug m-0 mt-0.5 text-slate-700';
            roleP.textContent = roleLabel(r.profile_role || r.role);
            identityText.appendChild(nameEl);
            identityText.appendChild(roleP);
            identity.appendChild(avatar);
            identity.appendChild(identityText);
            item.appendChild(identity);
            item.appendChild(buildDirectoryContactColumn(r, roleKey));
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

function getDirectoryEditPasswordEl() {
    return document.getElementById('directory-edit-password');
}

function resetDirectoryEditPasswordField() {
    const pw = getDirectoryEditPasswordEl();
    if (pw instanceof HTMLInputElement) {
        pw.value = '';
        pw.disabled = false;
        delete pw.dataset.masked;
    }
    directoryPasswordMasked = false;
}

function setDirectoryPasswordMaskedUi() {
    const pw = getDirectoryEditPasswordEl();
    if (!(pw instanceof HTMLInputElement)) return;
    pw.value = DIRECTORY_PW_MASK;
    pw.disabled = true;
    pw.dataset.masked = '1';
    directoryPasswordMasked = true;
}

function isDirectoryPasswordPending() {
    const pw = getDirectoryEditPasswordEl();
    if (!(pw instanceof HTMLInputElement)) return false;
    if (directoryPasswordMasked || pw.dataset.masked === '1') return false;
    return pw.value.trim().length > 0;
}

async function confirmLeaveDirectoryEditIfNeeded() {
    if (!isDirectoryPasswordPending()) return true;
    return confirmDirectoryAsync(
        'Un nouveau mot de passe a été saisi sans être appliqué. Quitter sans l’enregistrer ?'
    );
}

async function applyDirectoryEditPassword() {
    if (!editingUser?.id) return;
    const f = readDirectoryEditForm();
    if (!f.password) {
        showToast('Indiquez un mot de passe.', 'error');
        return;
    }
    if (f.password.length < PASSWORD_MIN_LENGTH) {
        showToast(`Mot de passe : au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
        return;
    }
    try {
        await planningAdminInvoke('set_password', { user_id: editingUser.id, password: f.password });
        setDirectoryPasswordMaskedUi();
        showToast('Mot de passe mis à jour.', 'success');
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

function syncDirectoryAddUserFab() {
    const u = getPlanningSessionUser();
    const listVisible = !document.getElementById('directory-users-list-panel')?.classList.contains('hidden');
    const editOpen = !document.getElementById('directory-user-edit-panel')?.classList.contains('hidden');
    const createOpen = !document.getElementById('directory-user-create-panel')?.classList.contains('hidden');
    document
        .getElementById('directory-add-user-wrap')
        ?.classList.toggle('hidden', !isAdmin(u) || !listVisible || editOpen || createOpen);
}

function showDirectoryListPanel() {
    document.getElementById('directory-users-list-panel')?.classList.remove('hidden');
    document.getElementById('directory-users-list-panel')?.setAttribute('aria-hidden', 'false');
    const edit = document.getElementById('directory-user-edit-panel');
    edit?.classList.add('hidden');
    edit?.setAttribute('aria-hidden', 'true');
    const create = document.getElementById('directory-user-create-panel');
    create?.classList.add('hidden');
    create?.setAttribute('aria-hidden', 'true');
    resetDirectoryEditPasswordField();
    editingUser = null;
    editSnapshot = null;
    setPlanningRouteBackHandler('modal_directory_users', () => popPlanningRouteLevel('modal_directory_users'));
    syncDirectoryAddUserFab();
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
    syncDirectoryAddUserFab();
    document.getElementById('directory-user-edit-panel')?.classList.add('hidden');
    const create = document.getElementById('directory-user-create-panel');
    create?.classList.remove('hidden');
    create?.setAttribute('aria-hidden', 'false');
    resetDirectoryCreateForm();
    pushPlanningRouteLevel(
        'modal_directory_users',
        planningRouteTitle('Nouvel utilisateur'),
        'Utilisateurs',
        showDirectoryListPanel
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
    document.getElementById('directory-users-list-panel')?.setAttribute('aria-hidden', 'true');
    document.getElementById('directory-admin-users-wrap')?.classList.add('hidden');
    document.getElementById('directory-admin-users-wrap')?.setAttribute('aria-hidden', 'true');
    document.getElementById('directory-user-create-panel')?.classList.add('hidden');
    const editPanel = document.getElementById('directory-user-edit-panel');
    editPanel?.classList.remove('hidden');
    editPanel?.setAttribute('aria-hidden', 'false');
    syncDirectoryAddUserFab();

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
    resetDirectoryEditPasswordField();
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
        void (async () => {
            if (!(await confirmLeaveDirectoryEditIfNeeded())) return;
            popPlanningRouteLevel('modal_directory_users');
        })();
    });

    pushPlanningRouteLevel(
        'modal_directory_users',
        planningRouteTitle(titleName),
        'Utilisateurs',
        () => {
            showDirectoryListPanel();
            void reloadDirectoryAfterEdit();
        }
    );
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
        syncDirectoryAddUserFab();
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
    document.getElementById('directory-edit-role')?.addEventListener('change', () =>
        void saveDirectoryField('role')
    );
    document.getElementById('directory-edit-password-apply')?.addEventListener('click', () => {
        void applyDirectoryEditPassword();
    });
    getDirectoryEditPasswordEl()?.addEventListener('focus', () => {
        if (directoryPasswordMasked) resetDirectoryEditPasswordField();
    });

    const directoryDlg = document.getElementById('modal_directory_users');
    directoryDlg?.addEventListener('cancel', (e) => {
        if (!editingUser || !isDirectoryPasswordPending()) return;
        e.preventDefault();
        void (async () => {
            if (await confirmLeaveDirectoryEditIfNeeded()) {
                directoryDlg.close();
            }
        })();
    });
    directoryDlg?.addEventListener('close', () => {
        showDirectoryListPanel();
    });
}
