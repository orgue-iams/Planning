/**
 * Pool calendriers Google secondaires — modale Agendas Google pour les utilisateurs (admin).
 */
import { isAdmin } from './auth-logic.js';
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { invokeCalendarBridge } from './calendar-bridge.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { normalizeGoogleCalendarId } from '../utils/google-calendar-id.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';
import {
    openPlanningRouteFromDrawer,
    planningRouteTitle,
    pushPlanningRouteLevel
} from '../utils/planning-route-dialog.js';
import { syncPlanningDrawerGroupedSections } from './planning-drawer-ui.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';
import { createPlanningIconDeleteButton } from '../utils/planning-delete-btn.js';

/** @type {{ key: 'label' | 'assignee_nom', dir: 'asc' | 'desc' }} */
let poolSort = { key: 'label', dir: 'asc' };

/** @type {any[]} */
let lastPoolRows = [];

/** @type {Record<string, unknown> | null} */
let editingPoolRow = null;

/** @type {{ label: string; google_calendar_id: string } | null} */
let poolEditSnapshot = null;

/** @type {string | null} */
let poolResyncInFlight = null;

const CALENDAR_POOL_ROUTE_LABEL = 'Agendas Google pour les utilisateurs';

function assigneeDisplayName(row) {
    const uid = String(row?.assigned_user_id ?? '').trim();
    const nom = String(row.assignee_nom ?? '').trim();
    const prenom = String(row.assignee_prenom ?? '').trim();
    const fromParts = formatProfileFullName(nom, prenom);
    if (fromParts) return fromParts;
    const disp = String(row.assignee_display_name ?? '').trim();
    if (disp) return disp;
    if (!uid) return '(Non attribué)';
    return '—';
}

function appendPoolUpdateButton(actions, opts) {
    const { poolId, mainResync, label } = opts;
    const upd = document.createElement('button');
    upd.type = 'button';
    upd.className =
        'calendar-pool-update-btn btn btn-primary btn-sm font-semibold text-[10px] min-h-8 px-2.5 shrink-0';
    if (mainResync) {
        upd.dataset.mainResync = '1';
    } else {
        upd.dataset.poolId = String(poolId ?? '');
    }
    upd.setAttribute('aria-label', `Resynchroniser ${label}`);
    upd.title = 'Resynchroniser les créneaux futurs depuis la base';
    const inFlight = mainResync
        ? poolResyncInFlight === '__main__'
        : poolResyncInFlight === String(poolId ?? '');
    upd.textContent = inFlight ? '…' : 'Resynchroniser';
    upd.disabled = inFlight;
    actions.appendChild(upd);
}

function buildMainPlanningCalendarCard() {
    const { mainGoogleCalendarId, mainGoogleCalendarLabel } = getPlanningConfig();
    const gid = String(mainGoogleCalendarId || '').trim();
    if (!gid) return null;

    const label =
        String(mainGoogleCalendarLabel || '').trim() || 'Planning complet (Orgue IAMS)';
    const card = document.createElement('div');
    card.className =
        'calendar-pool-card calendar-pool-card--main py-2.5 px-3 min-w-0 rounded-xl border';

    const grid = document.createElement('div');
    grid.className = 'calendar-pool-card__grid min-w-0';

    const left = document.createElement('div');
    left.className = 'calendar-pool-card__left min-w-0';
    appendPoolLabelWithAssignee(left, label, 'Agenda principal');
    const idP = document.createElement('p');
    idP.className =
        'text-[10px] sm:text-[11px] font-mono text-slate-900 m-0 mt-0.5 break-all leading-snug';
    idP.textContent = gid;
    left.appendChild(idP);

    const actions = document.createElement('div');
    actions.className = 'calendar-pool-card__actions';
    appendPoolUpdateButton(actions, { mainResync: true, label });

    grid.appendChild(left);
    grid.appendChild(actions);
    card.appendChild(grid);
    return card;
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

/** Attribués par libellé planning, puis non attribués par libellé. */
function sortPoolRowsForDisplay(rows) {
    const assigned = [];
    const unassigned = [];
    for (const r of rows) {
        if (String(r?.assigned_user_id ?? '').trim()) assigned.push(r);
        else unassigned.push(r);
    }
    const byLabel = (a, b) =>
        String(a.label || '').localeCompare(String(b.label || ''), 'fr', { sensitivity: 'base' });
    assigned.sort(byLabel);
    unassigned.sort(byLabel);
    return [...assigned, ...unassigned];
}

function appendPoolLabelWithAssignee(parent, planningLabel, assigneeText) {
    const labelP = document.createElement('p');
    labelP.className = 'text-[13px] font-semibold text-slate-900 m-0 leading-snug break-words';
    labelP.appendChild(document.createTextNode(planningLabel));
    const assigneeSpan = document.createElement('span');
    assigneeSpan.className = 'calendar-pool-card__assignee-inline font-semibold';
    assigneeSpan.textContent = ` (${assigneeText})`;
    labelP.appendChild(assigneeSpan);
    parent.appendChild(labelP);
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
    card.className = 'calendar-pool-card py-2.5 px-3 min-w-0 rounded-xl border';
    card.dataset.poolJson = JSON.stringify(row);

    const grid = document.createElement('div');
    grid.className = 'calendar-pool-card__grid min-w-0';

    const main = document.createElement('div');
    main.className = 'calendar-pool-card__main calendar-pool-card__left min-w-0 cursor-pointer';
    main.setAttribute('role', 'button');
    main.tabIndex = 0;

    const planningLabel = String(row.label || '').trim() || '—';
    appendPoolLabelWithAssignee(main, planningLabel, assigneeDisplayName(row));
    const idP = document.createElement('p');
    idP.className =
        'text-[10px] sm:text-[11px] font-mono text-slate-900 m-0 mt-0.5 break-all leading-snug';
    idP.textContent = String(row.google_calendar_id ?? '').trim() || '—';
    main.appendChild(idP);

    const actions = document.createElement('div');
    actions.className = 'calendar-pool-card__actions';
    const rowLabel = planningLabel === '—' ? 'Agenda' : planningLabel;
    appendPoolUpdateButton(actions, { poolId: row.id, label: rowLabel });
    const del = createPlanningIconDeleteButton({
        ariaLabel: 'Supprimer cet agenda',
        title: 'Supprimer',
        extraClass: 'calendar-pool-delete-btn'
    });
    del.dataset.poolId = String(row.id ?? '');
    actions.appendChild(del);

    grid.appendChild(main);
    grid.appendChild(actions);
    card.appendChild(grid);
    return card;
}

async function resyncMainPlanningCalendar() {
    const { mainGoogleCalendarId, mainGoogleCalendarLabel } = getPlanningConfig();
    const gid = String(mainGoogleCalendarId || '').trim();
    if (!gid || poolResyncInFlight) return;
    poolResyncInFlight = '__main__';
    renderPoolCards(lastPoolRows);
    const label =
        String(mainGoogleCalendarLabel || '').trim() || 'Planning complet (Orgue IAMS)';
    const status = document.getElementById('calendar-pool-status');
    if (status) status.textContent = `Resynchronisation de « ${label} »…`;
    try {
        const sb = getSupabaseClient();
        const token = (await sb?.auth.getSession())?.data?.session?.access_token ?? null;
        const res = await invokeCalendarBridge(token, {
            action: 'resync_calendar',
            googleCalendarId: gid
        });
        if (!res.ok) {
            showToast(res.error || 'Resynchronisation impossible.', 'error', 8000);
            return;
        }
        const data = /** @type {Record<string, unknown>} */ (res.data ?? {});
        const nUp = Number(data.upserted ?? 0);
        const nRm = Number(data.removed ?? 0);
        showToast(
            `« ${label} » : ${nUp} créneau(x) futur(s) resynchronisé(s), ${nRm} retiré(s) de Google.`,
            'success'
        );
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error', 8000);
    } finally {
        poolResyncInFlight = null;
        if (status) status.textContent = '';
        renderPoolCards(lastPoolRows);
    }
}

async function resyncPoolCalendarRow(poolId, rowForLabel) {
    const pid = String(poolId || '').trim();
    if (!pid || poolResyncInFlight) return;
    poolResyncInFlight = pid;
    renderPoolCards(lastPoolRows);
    const status = document.getElementById('calendar-pool-status');
    const label = String(rowForLabel?.label || '').trim() || 'Agenda';
    if (status) status.textContent = `Resynchronisation de « ${label} »…`;
    try {
        const res = await planningAdminInvoke('resync_calendar_pool', { pool_id: pid });
        const nUp = Number(res?.upserted ?? 0);
        const nRm = Number(res?.removed ?? 0);
        const errs = Array.isArray(res?.errors) ? res.errors : [];
        if (res?.ok === false && errs.length) {
            showToast(String(errs[0] || 'Resynchronisation partielle.'), 'error', 8000);
        } else if (errs.length) {
            showToast(
                `« ${label} » : ${nUp} mis à jour, ${nRm} retiré(s). ${errs.length} avertissement(s).`,
                'info',
                6000
            );
        } else {
            showToast(`« ${label} » : ${nUp} créneau(x) futur(s) resynchronisé(s), ${nRm} retiré(s) de Google.`, 'success');
        }
    } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error', 8000);
    } finally {
        poolResyncInFlight = null;
        if (status) status.textContent = '';
        renderPoolCards(lastPoolRows);
    }
}

function renderPoolCards(rows) {
    const host = document.getElementById('calendar-pool-list');
    if (!host) return;
    host.replaceChildren();
    const mainCard = buildMainPlanningCalendarCard();
    if (mainCard) host.appendChild(mainCard);

    const list = Array.isArray(rows) ? rows : [];
    if (!list.length && !mainCard) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-500 dark:text-slate-400 italic m-0 py-4 text-center';
        empty.textContent = 'Aucun agenda personnel dans le pool.';
        host.appendChild(empty);
        updatePoolSortButtonsUi();
        return;
    }
    for (const r of sortPoolRowsForDisplay(list)) {
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

    const titleLabel = label || 'Agenda';
    pushPlanningRouteLevel(
        'modal_calendar_pool',
        planningRouteTitle(titleLabel),
        CALENDAR_POOL_ROUTE_LABEL,
        () => {
            showPoolListPanel();
            void refreshCalendarPoolModalTable();
        }
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
        if (!openPlanningRouteFromDrawer('modal_calendar_pool', CALENDAR_POOL_ROUTE_LABEL, 'Menu')) {
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
        const updBtn = t.closest('.calendar-pool-update-btn');
        if (updBtn instanceof HTMLButtonElement) {
            ev.preventDefault();
            ev.stopPropagation();
            if (updBtn.dataset.mainResync === '1') {
                void resyncMainPlanningCalendar();
                return;
            }
            let row = null;
            try {
                const card = updBtn.closest('.calendar-pool-card');
                row = card?.dataset.poolJson ? JSON.parse(card.dataset.poolJson) : null;
            } catch {
                row = null;
            }
            void resyncPoolCalendarRow(updBtn.dataset.poolId || '', row);
            return;
        }
        const delBtn = t.closest('.calendar-pool-delete-btn');
        if (delBtn instanceof HTMLButtonElement) {
            ev.preventDefault();
            ev.stopPropagation();
            void deletePoolRow(delBtn.dataset.poolId || '');
            return;
        }
        const main = t.closest('.calendar-pool-card__main');
        const card = main?.closest('.calendar-pool-card');
        if (card?.classList.contains('calendar-pool-card--main')) return;
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
        if (card?.classList.contains('calendar-pool-card--main')) return;
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
