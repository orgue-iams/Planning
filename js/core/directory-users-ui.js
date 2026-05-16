/**
 * Annuaire interne : RPC planning_directory_users (élèves) ; admin/prof voient tout et éditent dans le tiroir route.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { isLikelySessionErrorMessage, notifySessionInvalid } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';
import { isAdmin, isProf, PASSWORD_MIN_LENGTH } from './auth-logic.js';
import { planningAdminInvoke } from './admin-api.js';
import { openAdminUserModalForCreate } from './admin-users-modal-ui.js';
import {
    openPlanningRouteDialog,
    setPlanningRouteBackHandler,
    updatePlanningRouteDialog
} from '../utils/planning-route-dialog.js';
import { closePlanningDrawer } from './planning-drawer-ui.js';
import { normalizePlanningRole } from './planning-roles.js';

let bound = false;
/** @type {object | null} */
let editingUser = null;
/** @type {object | null} */
let editSnapshot = null;

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

function privilegedLine2(r) {
    const email = String(r.email || '').trim();
    const phone = formatFrPhone(String(r.telephone || '').trim());
    const calLabel = String(r.personal_calendar_label || r.calendar_label || '').trim();
    const parts = [];
    if (email) parts.push({ type: 'email', value: email });
    if (phone) parts.push({ type: 'text', value: `Tél. ${phone}` });
    else parts.push({ type: 'text', value: 'Tél. —' });
    if (calLabel) parts.push({ type: 'text', value: `Agenda Google: ${calLabel}` });
    return parts;
}

function appendLine2(parent, parts) {
    const row = document.createElement('p');
    row.className =
        'mt-0.5 text-[12px] sm:text-[13px] leading-snug break-words min-w-0 text-slate-700 dark:text-slate-200 m-0';
    row.style.overflowWrap = 'anywhere';
    let first = true;
    for (const p of parts) {
        if (!first) row.appendChild(document.createTextNode(' · '));
        first = false;
        if (p.type === 'email' && p.value.includes('@')) {
            const a = document.createElement('a');
            a.href = `mailto:${p.value}`;
            a.className = 'directory-user-email-link';
            a.textContent = p.value;
            row.appendChild(a);
        } else {
            row.appendChild(document.createTextNode(p.value));
        }
    }
    parent.appendChild(row);
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

            const nameEl = document.createElement('p');
            nameEl.className =
                'font-semibold text-slate-900 dark:text-slate-100 leading-snug m-0 break-words';
            nameEl.style.overflowWrap = 'anywhere';
            nameEl.textContent = directoryDisplayName(r);
            item.appendChild(nameEl);

            const em = String(r.email || '').trim();
            const ph = formatFrPhone(String(r.telephone || '').trim());
            const emailRow = document.createElement('p');
            emailRow.className =
                'mt-0.5 text-[12px] sm:text-[13px] leading-snug break-words min-w-0 text-slate-700 dark:text-slate-200 m-0';
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
            if (ph) emailRow.appendChild(document.createTextNode(` · Tél. ${ph}`));
            item.appendChild(emailRow);
            list.appendChild(item);
        }
        block.appendChild(list);
        root.appendChild(block);
    }

    container.appendChild(root);
}

function renderPrivilegedDirectoryCards(users, canEdit) {
    const host = document.getElementById('directory-admin-users-table');
    if (!host) return;
    host.replaceChildren();

    const root = document.createElement('div');
    root.className = 'directory-users-stack space-y-2 min-w-0 text-[12px] sm:text-[13px]';

    const sorted = [...users].sort((a, b) =>
        `${String(a.nom || '')} ${String(a.prenom || '')}`.localeCompare(
            `${String(b.nom || '')} ${String(b.prenom || '')}`,
            'fr'
        )
    );

    for (const r of sorted) {
        const card = document.createElement('div');
        card.className =
            'directory-admin-user-card py-3 px-3 min-w-0 rounded-xl border border-slate-200 bg-slate-50/80 dark:border-slate-600 dark:bg-slate-800/70';
        card.dataset.userJson = JSON.stringify(r);
        if (canEdit) {
            card.classList.add('cursor-pointer', 'hover:border-primary/40', 'dark:hover:border-primary/50');
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
        }

        const nameP = document.createElement('p');
        nameP.className =
            'font-semibold text-slate-900 dark:text-slate-100 leading-snug m-0 break-words';
        nameP.style.overflowWrap = 'anywhere';
        nameP.textContent = directoryDisplayName(r);
        card.appendChild(nameP);
        appendLine2(card, privilegedLine2(r));
        root.appendChild(card);
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
        renderPrivilegedDirectoryCards(users, true);
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
    editingUser = null;
    editSnapshot = null;
    setPlanningRouteBackHandler('modal_directory_users', null);
    updatePlanningRouteDialog('modal_directory_users', 'Utilisateurs', 'Utilisateurs');
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
            showToast('Coordonnées enregistrées.');
        }
        if (adminUser && field === 'email' && f.email !== editSnapshot.email) {
            if (!f.email.includes('@')) {
                showToast('E-mail invalide.', 'error');
                return;
            }
            await planningAdminInvoke('update_user_email', { user_id: uid, email: f.email });
            editSnapshot.email = f.email;
            showToast('E-mail enregistré.');
        }
        if (adminUser && field === 'role' && f.role !== editSnapshot.role) {
            await planningAdminInvoke('update_role', { user_id: uid, role: f.role });
            editSnapshot.role = f.role;
            showToast('Rôle enregistré.');
        }
        if (adminUser && field === 'password' && f.password) {
            if (f.password.length < PASSWORD_MIN_LENGTH) {
                showToast(`Mot de passe : au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
                return;
            }
            await planningAdminInvoke('set_password', { user_id: uid, password: f.password });
            const pw = document.getElementById('directory-edit-password');
            if (pw instanceof HTMLInputElement) pw.value = '';
            showToast('Mot de passe mis à jour.');
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
        agendaEl.textContent = calLabel
            ? `Agenda Google: ${calLabel}`
            : 'Agenda Google: — (aucun agenda assigné)';
    }

    const titleName = directoryDisplayName(userRow);
    setPlanningRouteBackHandler('modal_directory_users', () => {
        showDirectoryListPanel();
        void reloadDirectoryAfterEdit();
    });
    updatePlanningRouteDialog(
        'modal_directory_users',
        `Utilisateurs / ${titleName}`,
        `Utilisateurs / ${titleName}`
    );
}

async function reloadDirectoryAfterEdit() {
    const u = getPlanningSessionUser();
    if (isDirectoryPrivileged(u)) await loadPrivilegedDirectoryIntoModal();
    else await loadDirectoryIntoModal();
}

export function resetDirectoryUsersUiBindings() {
    bound = false;
    editingUser = null;
    editSnapshot = null;
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
            showDirectoryListPanel();
            const u = getPlanningSessionUser();
            const privileged = isDirectoryPrivileged(u);
            document.getElementById('directory-add-user-wrap')?.classList.toggle('hidden', !isAdmin(u));
            const load = privileged ? loadPrivilegedDirectoryIntoModal() : loadDirectoryIntoModal();
            void load.then(() => openPlanningRouteDialog('modal_directory_users', 'Utilisateurs', 'Utilisateurs'));
        });
    });

    document.getElementById('directory-add-user-btn')?.addEventListener('click', () => {
        openAdminUserModalForCreate();
    });

    document.getElementById('directory-admin-users-table')?.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('a')) return;
        const card = t.closest('.directory-admin-user-card');
        if (!card?.dataset.userJson) return;
        try {
            openDirectoryUserEdit(JSON.parse(card.dataset.userJson));
        } catch {
            showToast('Impossible d’ouvrir la fiche utilisateur.', 'error');
        }
    });

    document.getElementById('directory-admin-users-table')?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target instanceof Element ? e.target.closest('.directory-admin-user-card') : null;
        if (!card?.dataset.userJson) return;
        e.preventDefault();
        try {
            openDirectoryUserEdit(JSON.parse(card.dataset.userJson));
        } catch {
            showToast('Impossible d’ouvrir la fiche utilisateur.', 'error');
        }
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

    document.getElementById('modal_users_admin')?.addEventListener('close', () => {
        if (!document.getElementById('modal_directory_users')?.open) return;
        showDirectoryListPanel();
        void reloadDirectoryAfterEdit();
    });

    document.getElementById('modal_directory_users')?.addEventListener('close', () => {
        showDirectoryListPanel();
    });
}
