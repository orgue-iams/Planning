/**
 * Pool calendriers Google secondaires — modale depuis le menu utilisateur (admin).
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { planningAdminInvoke } from './admin-api.js';
import { showToast } from '../utils/toast.js';
import { normalizeGoogleCalendarId } from '../utils/google-calendar-id.js';

function escapeTd(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
}

function renderPoolTableRows(rows) {
    const tb = document.getElementById('calendar-pool-tbody');
    if (!tb) return;
    tb.replaceChildren();
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML =
            '<td colspan="3" class="text-[10px] text-slate-500 text-center py-4">Aucune entrée. Ajoutez un calendrier ci-dessus.</td>';
        tb.appendChild(tr);
        return;
    }
    const sorted = [...list].sort((a, b) =>
        String(a.label || '').localeCompare(String(b.label || ''), 'fr', { sensitivity: 'base' })
    );
    for (const r of sorted) {
        const tr = document.createElement('tr');
        const free = !r.assigned_user_id;
        const st = free
            ? '<span class="text-emerald-700 font-medium text-[10px]">Libre</span>'
            : '<span class="text-amber-800 font-medium text-[10px]">Assigné</span>';
        tr.innerHTML = `
            <td class="text-[10px] max-w-[10rem] truncate" title="${escapeAttr(r.label || '')}">${escapeTd(r.label || '—')}</td>
            <td class="text-[9px] font-mono break-all">${escapeTd(r.google_calendar_id)}</td>
            <td class="text-[10px]">${st}</td>`;
        tb.appendChild(tr);
    }
}

export async function refreshCalendarPoolModalTable() {
    const res = await planningAdminInvoke('list_calendar_pool', {});
    renderPoolTableRows(res.rows || []);
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
        document.getElementById('btn-user-menu')?.blur();
        const dlg = document.getElementById('modal_calendar_pool');
        if (!dlg) {
            showToast('Fenêtre pool indisponible. Rechargez la page.', 'error');
            return;
        }
        requestAnimationFrame(() => {
            dlg.showModal();
            void refreshCalendarPoolModalTable().catch((err) =>
                showToast(err instanceof Error ? err.message : String(err), 'error')
            );
        });
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
