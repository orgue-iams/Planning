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
import { openPlanningRouteDialog } from '../utils/planning-route-dialog.js';
import { closePlanningDrawer } from './planning-drawer-ui.js';

function escapeTd(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
}

const POOL_COPY_URL_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 shrink-0" aria-hidden="true"><path d="M7.5 3A1.5 1.5 0 0 0 6 4.5v11A1.5 1.5 0 0 0 7.5 17H9V4.5A1.5 1.5 0 0 1 10.5 3h-3Z"/><path d="M10.5 4.5A1.5 1.5 0 0 1 12 3h4.379a1.5 1.5 0 0 1 1.06.44l2.121 2.121a1.5 1.5 0 0 1 .44 1.06V19.5A1.5 1.5 0 0 1 18.5 21h-6A1.5 1.5 0 0 1 11 19.5v-15Z"/></svg>';

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
            '<td colspan="4" class="text-[10px] text-slate-500 text-center py-4">Aucune entrée. Utilisez le bouton + pour ajouter un calendrier.</td>';
        tb.appendChild(tr);
        updatePoolSortButtonsUi();
        return;
    }
    const sorted = [...list].sort(cmpPoolRows);
    for (const r of sorted) {
        const tr = document.createElement('tr');
        const free = !r.assigned_user_id;
        const st = free
            ? '<span class="text-emerald-700 font-medium text-[10px]">Libre</span>'
            : '<span class="text-amber-800 font-medium text-[10px]">Assigné</span>';
        const gid = String(r.google_calendar_id ?? '').trim();
        const calUrl = googleCalendarEmbedUrl(gid);
        const nom = String(r.assignee_nom ?? '').trim();
        const prenom = String(r.assignee_prenom ?? '').trim();
        const assignee = free ? '—' : formatProfileFullName(nom, prenom) || '—';
        tr.innerHTML = `
            <td class="text-[10px] max-w-[11rem] truncate align-middle" title="${escapeAttr(r.label || '')}">${escapeTd(r.label || '—')}</td>
            <td class="align-middle p-1 min-w-0 max-w-[9.5rem] sm:max-w-[10.5rem]">
                <div class="flex items-center gap-0.5 min-w-0">
                    <span class="text-[9px] truncate flex-1 min-w-0" title="${escapeAttr(calUrl)}">${escapeTd(calUrl || '—')}</span>
                    ${
                        calUrl
                            ? `<button type="button" class="btn btn-ghost btn-xs btn-square h-7 w-7 min-h-7 min-w-7 p-0 shrink-0 calendar-pool-copy-url border border-slate-200 text-slate-700 hover:bg-slate-200/90 hover:text-slate-900" data-calendar-url="${escapeAttr(calUrl)}" title="Copier dans le presse-papiers" aria-label="Copier l’URL du calendrier">${POOL_COPY_URL_SVG}</button>`
                            : ''
                    }
                </div>
            </td>
            <td class="text-[10px] align-middle">${escapeTd(assignee)}</td>
            <td class="text-[10px] align-middle">${st}</td>`;
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

let poolUiBound = false;

export function resetAdminCalendarPoolBindings() {
    poolUiBound = false;
}

export function initAdminCalendarPoolUi(currentUser) {
    const show = isBackendAuthConfigured() && isAdmin(currentUser);
    document.getElementById('menu-item-calendar-pool-wrap')?.classList.toggle('hidden', !show);
    if (!show || poolUiBound) return;
    poolUiBound = true;

    document.getElementById('menu-item-calendar-pool')?.addEventListener('click', (e) => {
        e.preventDefault();
        closePlanningDrawer();
        document.getElementById('btn-app-drawer')?.blur();
        const dlg = document.getElementById('modal_calendar_pool');
        if (!dlg) {
            showToast('Fenêtre pool indisponible. Rechargez la page.', 'error');
            return;
        }
        poolSort = { key: 'label', dir: 'asc' };
        requestAnimationFrame(() => {
            void refreshCalendarPoolModalTable().catch((err) =>
                showToast(err instanceof Error ? err.message : String(err), 'error')
            );
            openPlanningRouteDialog('modal_calendar_pool', 'Calendriers des utilisateurs');
        });
    });

    document.getElementById('calendar-pool-sort-label')?.addEventListener('click', () => setPoolSort('label'));
    document.getElementById('calendar-pool-sort-assignee')?.addEventListener('click', () => setPoolSort('assignee_nom'));

    const openPoolAddModal = () => {
        const gid = document.getElementById('calendar-pool-add-google-id');
        const lb = document.getElementById('calendar-pool-add-label');
        if (gid instanceof HTMLInputElement) gid.value = '';
        if (lb instanceof HTMLInputElement) lb.value = '';
        document.getElementById('modal_calendar_pool_add')?.showModal();
        requestAnimationFrame(() => gid?.focus());
    };

    document.getElementById('calendar-pool-open-add')?.addEventListener('click', () => openPoolAddModal());

    document.getElementById('calendar-pool-add-cancel')?.addEventListener('click', () => {
        document.getElementById('modal_calendar_pool_add')?.close();
    });

    document.getElementById('modal_calendar_pool')?.addEventListener('click', async (ev) => {
        const t = ev.target;
        const btn = t instanceof Element ? t.closest('.calendar-pool-copy-url') : null;
        if (!(btn instanceof HTMLButtonElement)) return;
        const url = btn.getAttribute('data-calendar-url')?.trim();
        if (!url) {
            showToast('Aucune URL à copier.', 'error');
            return;
        }
        try {
            await navigator.clipboard.writeText(url);
            showToast('URL de l’agenda copiée.');
        } catch {
            showToast('Copie impossible.', 'error');
        }
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
