/**
 * Pool calendriers Google secondaires — modale Réglages → Calendriers des utilisateurs (admin).
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { normalizeGoogleCalendarId } from '../utils/google-calendar-id.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';

function escapeTd(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
}

const POOL_COPY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="w-3.5 h-3.5 shrink-0 opacity-80" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9 9 0 019 9zM18.75 10.5h-6.75a1.125 1.125 0 00-1.125 1.125v6.75" /></svg>';

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
            '<td colspan="4" class="text-[10px] text-slate-500 text-center py-4">Aucune entrée. Ajoutez un calendrier ci-dessus.</td>';
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
        const gid = String(r.google_calendar_id ?? '');
        const nom = String(r.assignee_nom ?? '').trim();
        const prenom = String(r.assignee_prenom ?? '').trim();
        const assignee = free ? '—' : formatProfileFullName(nom, prenom) || '—';
        tr.innerHTML = `
            <td class="text-[10px] max-w-[11rem] truncate align-middle" title="${escapeAttr(r.label || '')}">${escapeTd(r.label || '—')}</td>
            <td class="align-middle p-1 min-w-0 max-w-[9.5rem] sm:max-w-[10.5rem]">
                <div class="flex items-center gap-0.5 min-w-0">
                    <span class="text-[9px] font-mono truncate flex-1 min-w-0" title="${escapeAttr(gid)}">${escapeTd(gid)}</span>
                    <button type="button" class="btn btn-ghost btn-xs btn-square h-7 w-7 min-h-7 min-w-7 p-0 shrink-0 calendar-pool-copy-id border-0 text-slate-600 hover:bg-slate-200/90" data-calendar-id="${escapeAttr(gid)}" title="Copier l’ID" aria-label="Copier l’ID Google">${POOL_COPY_SVG}</button>
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
        document.getElementById('btn-header-settings')?.blur();
        const dlg = document.getElementById('modal_calendar_pool');
        if (!dlg) {
            showToast('Fenêtre pool indisponible. Rechargez la page.', 'error');
            return;
        }
        poolSort = { key: 'label', dir: 'asc' };
        requestAnimationFrame(() => {
            dlg.showModal();
            void refreshCalendarPoolModalTable().catch((err) =>
                showToast(err instanceof Error ? err.message : String(err), 'error')
            );
        });
    });

    document.getElementById('calendar-pool-sort-label')?.addEventListener('click', () => setPoolSort('label'));
    document.getElementById('calendar-pool-sort-assignee')?.addEventListener('click', () => setPoolSort('assignee_nom'));

    document.getElementById('modal_calendar_pool')?.addEventListener('click', async (ev) => {
        const t = ev.target;
        const btn = t instanceof Element ? t.closest('.calendar-pool-copy-id') : null;
        if (!(btn instanceof HTMLButtonElement)) return;
        const cid = btn.getAttribute('data-calendar-id')?.trim();
        if (!cid) {
            showToast('Aucun ID à copier.', 'error');
            return;
        }
        try {
            await navigator.clipboard.writeText(cid);
            showToast('ID Google copié.');
        } catch {
            showToast('Copie impossible.', 'error');
        }
    });

    document.getElementById('calendar-pool-refresh')?.addEventListener('click', () => {
        void refreshCalendarPoolModalTable().catch((err) =>
            showToast(err instanceof Error ? err.message : String(err), 'error')
        );
    });

    document.getElementById('calendar-pool-add-btn')?.addEventListener('click', async () => {
        const google_calendar_id = normalizeGoogleCalendarId(
            document.getElementById('calendar-pool-google-id')?.value ?? ''
        );
        const label = document.getElementById('calendar-pool-label')?.value?.trim() || '';
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
            const gid = document.getElementById('calendar-pool-google-id');
            const lb = document.getElementById('calendar-pool-label');
            if (gid) gid.value = '';
            if (lb) lb.value = '';
            await refreshCalendarPoolModalTable();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        }
    });
}
