/**
 * Pool calendriers Google secondaires — modale Réglages → Calendriers des utilisateurs (admin).
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { normalizeGoogleCalendarId } from '../utils/google-calendar-id.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';
import { openPlanningRouteFromDrawer } from '../utils/planning-route-dialog.js';
import { syncPlanningDrawerGroupedSections } from './planning-drawer-ui.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';

function escapeTd(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
}

/** @type {{ key: 'label' | 'assignee_nom', dir: 'asc' | 'desc' }} */
let poolSort = { key: 'label', dir: 'asc' };

/** @type {any[]} */
let lastPoolRows = [];

/**
 * @param {any} a
 * @param {any} b
 */
function cmpPoolRows(a, b) {
    const { key, dir } = poolSort;
    const m = dir === 'asc' ? 1 : -1;
    if (key === 'label') {
        return m * String(a.label || '').localeCompare(String(b.label || ''), 'fr', { sensitivity: 'base' });
    }
    /* assignee_nom : d’abord les assignés (tri par nom de famille), puis les libres (tri par libellé). */
    const af = !a.assigned_user_id;
    const bf = !b.assigned_user_id;
    if (!af && bf) return -1;
    if (af && !bf) return 1;
    if (af && bf) {
        return String(a.label || '').localeCompare(String(b.label || ''), 'fr', { sensitivity: 'base' });
    }
    const an = String(a.assignee_nom ?? '').trim().toLowerCase();
    const bn = String(b.assignee_nom ?? '').trim().toLowerCase();
    const c = an.localeCompare(bn, 'fr', { sensitivity: 'base' });
    if (c !== 0) return m * c;
    const ap = String(a.assignee_prenom ?? '').trim().toLowerCase();
    const bp = String(b.assignee_prenom ?? '').trim().toLowerCase();
    const cp = ap.localeCompare(bp, 'fr', { sensitivity: 'base' });
    if (cp !== 0) return m * cp;
    return String(a.label || '').localeCompare(String(b.label || ''), 'fr', { sensitivity: 'base' });
}

function updatePoolSortButtonsUi() {
    const bLabel = document.getElementById('calendar-pool-sort-label');
    const bNom = document.getElementById('calendar-pool-sort-assignee');
    const arrow = (active, asc) => (active ? (asc ? ' ▲' : ' ▼') : '');
    if (bLabel instanceof HTMLButtonElement) {
        bLabel.setAttribute('aria-pressed', String(poolSort.key === 'label'));
        bLabel.title = 'Trier par libellé du calendrier';
        bLabel.textContent = `Libellé${arrow(poolSort.key === 'label', poolSort.dir === 'asc')}`;
    }
    if (bNom instanceof HTMLButtonElement) {
        bNom.setAttribute('aria-pressed', String(poolSort.key === 'assignee_nom'));
        bNom.title =
            'Calendriers assignés en premier, triés par nom de famille ; puis calendriers libres, triés par libellé.';
        bNom.textContent = `Assigné à${arrow(poolSort.key === 'assignee_nom', poolSort.dir === 'asc')}`;
    }
}

function renderPoolTableRows(rows) {
    const tb = document.getElementById('calendar-pool-tbody');
    if (!tb) return;
    tb.replaceChildren();
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML =
            '<td colspan="3" class="text-[11px] text-slate-500 text-center py-4 dark:text-slate-400">Aucune entrée. Utilisez « Rajouter un agenda Google ».</td>';
        tb.appendChild(tr);
        updatePoolSortButtonsUi();
        return;
    }
    const sorted = [...list].sort(cmpPoolRows);
    for (const r of sorted) {
        const tr = document.createElement('tr');
        const gid = String(r.google_calendar_id ?? '').trim();
        const calUrl = googleCalendarEmbedUrl(gid);
        const nom = String(r.assignee_nom ?? '').trim();
        const prenom = String(r.assignee_prenom ?? '').trim();
        const assignee = formatProfileFullName(nom, prenom) || '—';
        tr.className = 'calendar-pool-row cursor-pointer hover:bg-slate-100/80 dark:hover:bg-slate-700/50';
        tr.dataset.poolId = String(r.id ?? '');
        tr.dataset.poolJson = JSON.stringify(r);
        tr.innerHTML = `
            <td class="text-[11px] max-w-[8rem] sm:max-w-[12rem] align-middle py-2 break-words" title="${escapeAttr(r.label || '')}">${escapeTd(r.label || '—')}</td>
            <td class="align-middle py-2 min-w-0 p-1 pool-cal-url-cell">
                <span class="text-[10px] sm:text-[11px] font-mono text-slate-700 dark:text-slate-300 break-all whitespace-normal block" title="${escapeAttr(calUrl)}">${escapeTd(calUrl || '—')}</span>
            </td>
            <td class="text-[11px] align-middle py-2 break-words">${escapeTd(assignee)}</td>`;
        tb.appendChild(tr);
    }
    updatePoolSortButtonsUi();
}

function setPoolSort(key) {
    if (poolSort.key === key) {
        poolSort = { key, dir: poolSort.dir === 'asc' ? 'desc' : 'asc' };
    } else {
        poolSort = { key, dir: 'asc' };
    }
    renderPoolTableRows(lastPoolRows);
}

export async function refreshCalendarPoolModalTable() {
    const res = await planningAdminInvoke('list_calendar_pool', {});
    lastPoolRows = Array.isArray(res.rows) ? res.rows : [];
    renderPoolTableRows(lastPoolRows);
}

function confirmPoolDelete(message) {
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

/** @param {Record<string, unknown>} row */
function openCalendarPoolEdit(row) {
    const id = String(row.id ?? '');
    const gid = String(row.google_calendar_id ?? '').trim();
    const label = String(row.label ?? '').trim();
    const idEl = document.getElementById('calendar-pool-edit-id');
    const gidEl = document.getElementById('calendar-pool-edit-google-id');
    const lbEl = document.getElementById('calendar-pool-edit-label');
    if (idEl instanceof HTMLInputElement) idEl.value = id;
    if (gidEl instanceof HTMLInputElement) gidEl.value = gid;
    if (lbEl instanceof HTMLInputElement) lbEl.value = label;

    const ul = document.getElementById('calendar-pool-edit-assignees');
    if (ul) {
        ul.replaceChildren();
        const uid = row.assigned_user_id;
        if (uid) {
            const nom = String(row.assignee_nom ?? '').trim();
            const prenom = String(row.assignee_prenom ?? '').trim();
            const name = formatProfileFullName(nom, prenom) || String(uid);
            const li = document.createElement('li');
            li.textContent = name;
            ul.appendChild(li);
        } else {
            const li = document.createElement('li');
            li.className = 'list-none text-slate-500 dark:text-slate-400 italic';
            li.textContent = 'Aucun utilisateur lié';
            ul.appendChild(li);
        }
    }

    const dlg = document.getElementById('modal_calendar_pool_edit');
    dlg?.showModal();
    focusPlanningDialogRoot(dlg instanceof HTMLDialogElement ? dlg : null);
}

async function saveCalendarPoolEditOnClose() {
    const poolId = document.getElementById('calendar-pool-edit-id')?.value?.trim();
    if (!poolId) return;
    const google_calendar_id = normalizeGoogleCalendarId(
        document.getElementById('calendar-pool-edit-google-id')?.value ?? ''
    );
    const label = document.getElementById('calendar-pool-edit-label')?.value?.trim() || '';
    if (!google_calendar_id) {
        showToast('URL ou ID Google Calendar invalide.', 'error');
        return;
    }
    try {
        await planningAdminInvoke('update_calendar_pool', {
            pool_id: poolId,
            google_calendar_id,
            label: label || null
        });
        showToast('Agenda enregistré.');
        await refreshCalendarPoolModalTable();
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

async function deleteCalendarPoolFromEdit() {
    const poolId = document.getElementById('calendar-pool-edit-id')?.value?.trim();
    if (!poolId) return;
    try {
        let res = await planningAdminInvoke('delete_calendar_pool', { pool_id: poolId });
        if (res?.needs_confirmation && Array.isArray(res.assignees) && res.assignees.length) {
            const names = res.assignees
                .map((a) => {
                    const p = String(a.prenom ?? '').trim();
                    const n = String(a.nom ?? '').trim();
                    return [p, n].filter(Boolean).join(' ') || a.email || a.id;
                })
                .join(', ');
            const ok = await confirmPoolDelete(
                `Cet agenda est lié à : ${names}. En le supprimant, il faudra rattacher manuellement un nouveau calendrier à cet utilisateur. Confirmer la suppression ?`
            );
            if (!ok) return;
            res = await planningAdminInvoke('delete_calendar_pool', { pool_id: poolId, force: true });
        }
        if (res?.ok === false && !res?.needs_confirmation) {
            throw new Error(res?.error || 'Suppression impossible');
        }
        showToast('Agenda supprimé.');
        document.getElementById('modal_calendar_pool_edit')?.close();
        await refreshCalendarPoolModalTable();
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

let poolUiBound = false;

export function resetAdminCalendarPoolBindings() {
    poolUiBound = false;
}

export function initAdminCalendarPoolUi(currentUser) {
    const show = isBackendAuthConfigured() && isAdmin(currentUser);
    document.getElementById('menu-item-calendar-pool-wrap')?.classList.toggle('hidden', !show);
    syncPlanningDrawerGroupedSections();
    if (!show || poolUiBound) return;
    poolUiBound = true;

    document.getElementById('menu-item-calendar-pool')?.addEventListener('click', (e) => {
        e.preventDefault();
        const dlg = document.getElementById('modal_calendar_pool');
        if (!dlg) {
            showToast('Fenêtre pool indisponible. Rechargez la page.', 'error');
            return;
        }
        poolSort = { key: 'label', dir: 'asc' };
        if (!openPlanningRouteFromDrawer('modal_calendar_pool', 'Calendriers des utilisateurs', 'Calendriers')) {
            return;
        }
        void refreshCalendarPoolModalTable().catch((err) =>
            showToast(err instanceof Error ? err.message : String(err), 'error')
        );
    });

    document.getElementById('calendar-pool-sort-label')?.addEventListener('click', () => setPoolSort('label'));
    document.getElementById('calendar-pool-sort-assignee')?.addEventListener('click', () => setPoolSort('assignee_nom'));

    const openPoolAddModal = () => {
        const gid = document.getElementById('calendar-pool-add-google-id');
        const lb = document.getElementById('calendar-pool-add-label');
        if (gid instanceof HTMLInputElement) gid.value = '';
        if (lb instanceof HTMLInputElement) lb.value = '';
        document.getElementById('modal_calendar_pool_add')?.showModal();
        const addDlg = document.getElementById('modal_calendar_pool_add');
        focusPlanningDialogRoot(addDlg instanceof HTMLDialogElement ? addDlg : null);
    };

    document.getElementById('calendar-pool-open-add')?.addEventListener('click', () => openPoolAddModal());

    document.getElementById('calendar-pool-add-cancel')?.addEventListener('click', () => {
        document.getElementById('modal_calendar_pool_add')?.close();
    });

    document.getElementById('calendar-pool-tbody')?.addEventListener('click', (ev) => {
        const t = ev.target;
        const row = t instanceof Element ? t.closest('tr.calendar-pool-row') : null;
        if (!row?.dataset.poolJson) return;
        try {
            openCalendarPoolEdit(JSON.parse(row.dataset.poolJson));
        } catch {
            showToast('Impossible d’ouvrir l’agenda.', 'error');
        }
    });

    document.getElementById('calendar-pool-edit-close')?.addEventListener('click', () => {
        void saveCalendarPoolEditOnClose().finally(() => {
            document.getElementById('modal_calendar_pool_edit')?.close();
        });
    });

    document.getElementById('modal_calendar_pool_edit')?.addEventListener('close', () => {
        const idEl = document.getElementById('calendar-pool-edit-id');
        if (idEl instanceof HTMLInputElement) idEl.value = '';
    });

    document.getElementById('calendar-pool-edit-delete')?.addEventListener('click', () => {
        void deleteCalendarPoolFromEdit();
    });

    const submitPoolAdd = async () => {
        const google_calendar_id = normalizeGoogleCalendarId(
            document.getElementById('calendar-pool-add-google-id')?.value ?? ''
        );
        const label = document.getElementById('calendar-pool-add-label')?.value?.trim() || '';
        if (!google_calendar_id) {
            showToast('Indiquez l’ID du calendrier Google.', 'error');
            return;
        }
        try {
            await planningAdminInvoke('add_calendar_pool', {
                google_calendar_id,
                label: label || undefined,
                sort_order: 0
            });
            showToast('Calendrier ajouté au pool.');
            document.getElementById('modal_calendar_pool_add')?.close();
            await refreshCalendarPoolModalTable();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        }
    };

    document.getElementById('calendar-pool-add-submit')?.addEventListener('click', () => void submitPoolAdd());
    document.getElementById('modal_calendar_pool_add')?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.closest('#calendar-pool-add-google-id, #calendar-pool-add-label')) return;
        e.preventDefault();
        void submitPoolAdd();
    });
}
