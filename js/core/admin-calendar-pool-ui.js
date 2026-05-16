/**
 * Pool calendriers Google secondaires — modale route Calendriers (admin).
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { normalizeGoogleCalendarId } from '../utils/google-calendar-id.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';
import {
    openPlanningRouteFromDrawer,
    setPlanningRouteBackHandler,
    updatePlanningRouteDialog
} from '../utils/planning-route-dialog.js';
import { syncPlanningDrawerGroupedSections } from './planning-drawer-ui.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';

/** @type {{ key: 'label' | 'assignee_nom', dir: 'asc' | 'desc' }} */
let poolSort = { key: 'label', dir: 'asc' };

/** @type {any[]} */
let lastPoolRows = [];

/** @type {Record<string, unknown> | null} */
let editingPoolRow = null;

/** @type {{ label: string; google_calendar_id: string } | null} */
let poolEditSnapshot = null;

const DELETE_POOL_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m2 0H7m2-3h6a1 1 0 011 1v1H8V5a1 1 0 011-1z"/></svg>';

function assigneeDisplayName(row) {
    const nom = String(row.assignee_nom ?? '').trim();
    const prenom = String(row.assignee_prenom ?? '').trim();
    return formatProfileFullName(nom, prenom) || '—';
}

function cmpPoolRows(a, b) {
    const { key, dir } = poolSort;
    const m = dir === 'asc' ? 1 : -1;
    if (key === 'label') {
        return m * String(a.label || '').localeCompare(String(b.label || ''), 'fr', { sensitivity: 'base' });
    }
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
    const arrow = (active, asc) => (active ? (asc ? ' ▲' : ' ▼') : '');
    const bLabel = document.getElementById('calendar-pool-sort-label');
    const bNom = document.getElementById('calendar-pool-sort-assignee');
    if (bLabel instanceof HTMLButtonElement) {
        bLabel.setAttribute('aria-pressed', String(poolSort.key === 'label'));
        bLabel.textContent = `Libellé${arrow(poolSort.key === 'label', poolSort.dir === 'asc')}`;
    }
    if (bNom instanceof HTMLButtonElement) {
        bNom.setAttribute('aria-pressed', String(poolSort.key === 'assignee_nom'));
        bNom.textContent = `Utilisateur lié${arrow(poolSort.key === 'assignee_nom', poolSort.dir === 'asc')}`;
    }
}

function buildPoolCard(row) {
    const card = document.createElement('div');
    card.className =
        'calendar-pool-card flex items-stretch gap-2 py-2.5 px-3 min-w-0 rounded-xl border border-slate-200 bg-slate-50/80 dark:border-slate-600 dark:bg-slate-800/70';
    card.dataset.poolJson = JSON.stringify(row);

    const main = document.createElement('div');
    main.className = 'calendar-pool-card__main flex flex-1 min-w-0 gap-2 cursor-pointer';
    main.setAttribute('role', 'button');
    main.tabIndex = 0;

    const left = document.createElement('div');
    left.className = 'calendar-pool-card__left flex-1 min-w-0 max-w-full';
    const line1 = document.createElement('div');
    line1.className =
        'flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[13px] leading-snug';
    const labelP = document.createElement('span');
    labelP.className = 'font-semibold text-slate-900 dark:text-slate-100 break-words text-left';
    labelP.textContent = String(row.label || '').trim() || '—';
    const userP = document.createElement('span');
    userP.className = 'text-[11px] sm:text-xs text-slate-600 dark:text-slate-300 shrink-0 text-right';
    userP.textContent = assigneeDisplayName(row);
    line1.appendChild(labelP);
    line1.appendChild(userP);
    const idP = document.createElement('p');
    idP.className =
        'text-[10px] sm:text-[11px] font-mono text-slate-700 dark:text-slate-200 m-0 mt-0.5 break-all leading-snug';
    idP.textContent = String(row.google_calendar_id ?? '').trim() || '—';
    left.appendChild(line1);
    left.appendChild(idP);

    const del = document.createElement('button');
    del.type = 'button';
    del.className =
        'calendar-pool-delete-btn btn btn-ghost btn-xs btn-square shrink-0 self-center border border-transparent text-slate-500 hover:text-error';
    del.dataset.poolId = String(row.id ?? '');
    del.setAttribute('aria-label', 'Supprimer cet agenda');
    del.title = 'Supprimer';
    del.innerHTML = DELETE_POOL_SVG;

    main.appendChild(left);
    card.appendChild(main);
    card.appendChild(del);
    return card;
}

function renderPoolCards(rows) {
    const host = document.getElementById('calendar-pool-list');
    if (!host) return;
    host.replaceChildren();
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-500 dark:text-slate-400 italic m-0 py-4 text-center';
        empty.textContent = 'Aucune entrée. Utilisez « Rajouter un agenda Google ».';
        host.appendChild(empty);
        updatePoolSortButtonsUi();
        return;
    }
    for (const r of [...list].sort(cmpPoolRows)) {
        host.appendChild(buildPoolCard(r));
    }
    updatePoolSortButtonsUi();
}

export async function refreshCalendarPoolModalTable() {
    const res = await planningAdminInvoke('list_calendar_pool', {});
    lastPoolRows = Array.isArray(res.rows) ? res.rows : [];
    renderPoolCards(lastPoolRows);
}

function showPoolListPanel() {
    document.getElementById('calendar-pool-list-panel')?.classList.remove('hidden');
    const edit = document.getElementById('calendar-pool-edit-panel');
    edit?.classList.add('hidden');
    edit?.setAttribute('aria-hidden', 'true');
    editingPoolRow = null;
    poolEditSnapshot = null;
    setPlanningRouteBackHandler('modal_calendar_pool', null);
    updatePlanningRouteDialog('modal_calendar_pool', 'Calendriers', 'Calendriers');
}

function readPoolEditForm() {
    return {
        label: String(document.getElementById('calendar-pool-edit-label')?.value || '').trim(),
        google_calendar_id: String(document.getElementById('calendar-pool-edit-google-id')?.value || '').trim()
    };
}

async function savePoolField(field) {
    if (!editingPoolRow?.id || !poolEditSnapshot) return;
    const poolId = String(editingPoolRow.id);
    const f = readPoolEditForm();
    const patch = {};
    if (field === 'label' && f.label !== poolEditSnapshot.label) {
        patch.label = f.label || null;
    }
    if (field === 'google_calendar_id') {
        const gid = normalizeGoogleCalendarId(f.google_calendar_id);
        if (!gid) {
            showToast('ID Google Calendar invalide.', 'error');
            return;
        }
        if (gid !== poolEditSnapshot.google_calendar_id) {
            patch.google_calendar_id = gid;
        }
    }
    if (!Object.keys(patch).length) return;
    try {
        await planningAdminInvoke('update_calendar_pool', { pool_id: poolId, ...patch });
        if (patch.label !== undefined) poolEditSnapshot.label = f.label;
        if (patch.google_calendar_id) poolEditSnapshot.google_calendar_id = patch.google_calendar_id;
        showToast('Agenda enregistré.');
        await refreshCalendarPoolModalTable();
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

function openPoolEdit(row) {
    editingPoolRow = row;
    const label = String(row.label ?? '').trim();
    const gid = String(row.google_calendar_id ?? '').trim();
    poolEditSnapshot = { label, google_calendar_id: gid };

    document.getElementById('calendar-pool-list-panel')?.classList.add('hidden');
    const editPanel = document.getElementById('calendar-pool-edit-panel');
    editPanel?.classList.remove('hidden');
    editPanel?.setAttribute('aria-hidden', 'false');

    const idEl = document.getElementById('calendar-pool-edit-id');
    if (idEl instanceof HTMLInputElement) idEl.value = String(row.id ?? '');
    const lb = document.getElementById('calendar-pool-edit-label');
    const gidEl = document.getElementById('calendar-pool-edit-google-id');
    if (lb instanceof HTMLInputElement) lb.value = label;
    if (gidEl instanceof HTMLInputElement) gidEl.value = gid;

    const assigneeEl = document.getElementById('calendar-pool-edit-assignee-readonly');
    if (assigneeEl) {
        assigneeEl.textContent = row.assigned_user_id
            ? assigneeDisplayName(row)
            : 'Aucun utilisateur lié';
    }

    const backLabel = label || 'Agenda';
    setPlanningRouteBackHandler('modal_calendar_pool', () => {
        showPoolListPanel();
        void refreshCalendarPoolModalTable();
    });
    updatePlanningRouteDialog(
        'modal_calendar_pool',
        `Calendriers / ${backLabel}`,
        `Calendriers / ${backLabel}`
    );
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

async function deletePoolRow(poolId, rowForNames) {
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
        showPoolListPanel();
        await refreshCalendarPoolModalTable();
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
    }
}

let poolUiBound = false;

export function resetAdminCalendarPoolBindings() {
    poolUiBound = false;
    editingPoolRow = null;
    poolEditSnapshot = null;
}

export function initAdminCalendarPoolUi(currentUser) {
    const show = isBackendAuthConfigured() && isAdmin(currentUser);
    document.getElementById('menu-item-calendar-pool-wrap')?.classList.toggle('hidden', !show);
    syncPlanningDrawerGroupedSections();
    if (!show || poolUiBound) return;
    poolUiBound = true;

    document.getElementById('menu-item-calendar-pool')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!document.getElementById('modal_calendar_pool')) {
            showToast('Fenêtre pool indisponible. Rechargez la page.', 'error');
            return;
        }
        poolSort = { key: 'label', dir: 'asc' };
        showPoolListPanel();
        if (!openPlanningRouteFromDrawer('modal_calendar_pool', 'Calendriers', 'Calendriers')) {
            return;
        }
        const status = document.getElementById('calendar-pool-status');
        if (status) status.textContent = 'Chargement…';
        void refreshCalendarPoolModalTable()
            .then(() => {
                if (status) status.textContent = '';
            })
            .catch((err) => {
                if (status) status.textContent = '';
                showToast(err instanceof Error ? err.message : String(err), 'error');
            });
    });

    document.getElementById('calendar-pool-sort-label')?.addEventListener('click', () => {
        poolSort =
            poolSort.key === 'label'
                ? { key: 'label', dir: poolSort.dir === 'asc' ? 'desc' : 'asc' }
                : { key: 'label', dir: 'asc' };
        renderPoolCards(lastPoolRows);
    });
    document.getElementById('calendar-pool-sort-assignee')?.addEventListener('click', () => {
        poolSort =
            poolSort.key === 'assignee_nom'
                ? { key: 'assignee_nom', dir: poolSort.dir === 'asc' ? 'desc' : 'asc' }
                : { key: 'assignee_nom', dir: 'asc' };
        renderPoolCards(lastPoolRows);
    });

    document.getElementById('calendar-pool-open-add')?.addEventListener('click', () => {
        const gid = document.getElementById('calendar-pool-add-google-id');
        const lb = document.getElementById('calendar-pool-add-label');
        if (gid instanceof HTMLInputElement) gid.value = '';
        if (lb instanceof HTMLInputElement) lb.value = '';
        const addDlg = document.getElementById('modal_calendar_pool_add');
        addDlg?.showModal();
        focusPlanningDialogRoot(addDlg instanceof HTMLDialogElement ? addDlg : null);
    });

    document.getElementById('calendar-pool-add-cancel')?.addEventListener('click', () => {
        document.getElementById('modal_calendar_pool_add')?.close();
    });

    document.getElementById('calendar-pool-list')?.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const delBtn = t.closest('.calendar-pool-delete-btn');
        if (delBtn instanceof HTMLButtonElement) {
            ev.preventDefault();
            ev.stopPropagation();
            void deletePoolRow(delBtn.dataset.poolId || '');
            return;
        }
        const main = t.closest('.calendar-pool-card__main');
        const card = main?.closest('.calendar-pool-card');
        if (!card?.dataset.poolJson) return;
        try {
            openPoolEdit(JSON.parse(card.dataset.poolJson));
        } catch {
            showToast('Impossible d’ouvrir l’agenda.', 'error');
        }
    });

    document.getElementById('calendar-pool-list')?.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const main = ev.target instanceof Element ? ev.target.closest('.calendar-pool-card__main') : null;
        const card = main?.closest('.calendar-pool-card');
        if (!card?.dataset.poolJson) return;
        ev.preventDefault();
        try {
            openPoolEdit(JSON.parse(card.dataset.poolJson));
        } catch {
            showToast('Impossible d’ouvrir l’agenda.', 'error');
        }
    });

    document.getElementById('calendar-pool-edit-label')?.addEventListener('blur', () =>
        void savePoolField('label')
    );
    document.getElementById('calendar-pool-edit-google-id')?.addEventListener('blur', () =>
        void savePoolField('google_calendar_id')
    );

    document.getElementById('calendar-pool-edit-delete')?.addEventListener('click', () => {
        const poolId = document.getElementById('calendar-pool-edit-id')?.value?.trim();
        if (poolId) void deletePoolRow(poolId, editingPoolRow);
    });

    document.getElementById('modal_calendar_pool')?.addEventListener('close', () => {
        showPoolListPanel();
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
