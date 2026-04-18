/**
 * Modale unique : allocation élèves ↔ créneau « cours » (semaines types + réservation).
 * @typedef {{ user_id: string, nom?: string, prenom?: string, email?: string }} EleveRow
 */

import { showToast } from '../utils/toast.js';

/** @param {EleveRow} e */
function eleveLabel(e) {
    const p = String(e?.prenom || '').trim();
    const n = String(e?.nom || '').trim();
    const t = `${p} ${n}`.trim();
    if (t) return t;
    return String(e?.email || e?.user_id || '').trim() || String(e?.user_id || '');
}

function escapeAttr(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * @param {{
 *   title?: string,
 *   maxStudents?: number,
 *   eleves: EleveRow[],
 *   selectedUserIds: string[],
 * }} opts
 * @returns {Promise<string[] | null>} ids sélectionnés, ou null si annulé
 */
export function openCourseStudentsPicker(opts) {
    const dlg = document.getElementById('modal_course_students');
    const titleEl = document.getElementById('csp-title');
    const maxLab = document.getElementById('csp-max-label');
    const inEl = document.getElementById('csp-list-in');
    const outEl = document.getElementById('csp-list-out');
    const btnOk = document.getElementById('csp-btn-ok');
    const btnCancel = document.getElementById('csp-btn-cancel');
    if (!dlg || !inEl || !outEl || !btnOk || !btnCancel) {
        return Promise.resolve(null);
    }

    const max = Math.max(1, Math.min(20, Number(opts.maxStudents ?? 5)));
    const byId = new Map((opts.eleves || []).map((e) => [String(e.user_id), e]));
    const allIds = [...byId.keys()].filter(Boolean);
    /** @type {Set<string>} */
    let inSet = new Set((opts.selectedUserIds || []).map((x) => String(x)).filter((id) => byId.has(id)));

    if (titleEl) titleEl.textContent = opts.title || 'Inscriptions au cours';
    if (maxLab) maxLab.textContent = String(max);

    const render = () => {
        const inRows = [];
        const outRows = [];
        for (const id of allIds) {
            const e = byId.get(id);
            if (!e) continue;
            const row = { id, label: eleveLabel(e) };
            if (inSet.has(id)) inRows.push(row);
            else outRows.push(row);
        }
        const sortFn = (a, b) =>
            a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' });
        inRows.sort(sortFn);
        outRows.sort(sortFn);
        const mkBtn = (id, label) =>
            `<button type="button" draggable="true" class="csp-student-row cursor-grab active:cursor-grabbing btn btn-ghost btn-sm h-auto min-h-0 py-1.5 px-2 text-left text-[11px] font-normal font-sans w-full justify-start border border-transparent hover:border-slate-200" data-user-id="${escapeAttr(id)}">${escapeAttr(label)}</button>`;
        inEl.innerHTML = inRows.length ? inRows.map((r) => mkBtn(r.id, r.label)).join('') : '<p class="text-[10px] text-slate-400 px-1 py-2">Aucun inscrit.</p>';
        outEl.innerHTML = outRows.length ? outRows.map((r) => mkBtn(r.id, r.label)).join('') : '<p class="text-[10px] text-slate-400 px-1 py-2">Aucun élève disponible.</p>';
    };

    const onRowClick = (ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const btn = t.closest('.csp-student-row');
        if (!btn) return;
        const id = btn.getAttribute('data-user-id') || '';
        if (!id || !byId.has(id)) return;
        if (inSet.has(id)) {
            inSet.delete(id);
        } else {
            if (inSet.size >= max) return;
            inSet.add(id);
        }
        render();
    };

    const onDragStart = (ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const btn = t.closest('.csp-student-row');
        if (!btn || !dlg.contains(btn)) return;
        const dt = ev.dataTransfer;
        if (dt) {
            dt.setData('text/plain', btn.getAttribute('data-user-id') || '');
            dt.effectAllowed = 'move';
        }
    };

    const onDragOver = (ev) => {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    };

    const onDropIn = (ev) => {
        ev.preventDefault();
        inEl.classList.remove('st-dnd-drop-active');
        const id = String(ev.dataTransfer?.getData('text/plain') || '').trim();
        if (!id || !byId.has(id) || inSet.has(id)) return;
        if (inSet.size >= max) {
            showToast(`Maximum ${max} élève(s) pour ce cours.`, 'error');
            return;
        }
        inSet.add(id);
        render();
    };

    const onDropOut = (ev) => {
        ev.preventDefault();
        outEl.classList.remove('st-dnd-drop-active');
        const id = String(ev.dataTransfer?.getData('text/plain') || '').trim();
        if (!id || !inSet.has(id)) return;
        inSet.delete(id);
        render();
    };

    const onDragEnterIn = () => inEl.classList.add('st-dnd-drop-active');
    const onDragLeaveIn = () => inEl.classList.remove('st-dnd-drop-active');
    const onDragEnterOut = () => outEl.classList.add('st-dnd-drop-active');
    const onDragLeaveOut = () => outEl.classList.remove('st-dnd-drop-active');

    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            inEl.removeEventListener('click', onRowClick);
            outEl.removeEventListener('click', onRowClick);
            dlg.removeEventListener('dragstart', onDragStart);
            inEl.removeEventListener('dragover', onDragOver);
            outEl.removeEventListener('dragover', onDragOver);
            inEl.removeEventListener('dragenter', onDragEnterIn);
            inEl.removeEventListener('dragleave', onDragLeaveIn);
            outEl.removeEventListener('dragenter', onDragEnterOut);
            outEl.removeEventListener('dragleave', onDragLeaveOut);
            inEl.removeEventListener('drop', onDropIn);
            outEl.removeEventListener('drop', onDropOut);
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            dlg.removeEventListener('close', onClose);
            try {
                dlg.close();
            } catch {
                /* ignore */
            }
            resolve(val);
        };
        const onOk = () => finish([...inSet]);
        const onCancel = () => finish(null);
        const onClose = () => finish(null);

        render();
        inEl.addEventListener('click', onRowClick);
        outEl.addEventListener('click', onRowClick);
        dlg.addEventListener('dragstart', onDragStart);
        inEl.addEventListener('dragover', onDragOver);
        outEl.addEventListener('dragover', onDragOver);
        inEl.addEventListener('dragenter', onDragEnterIn);
        inEl.addEventListener('dragleave', onDragLeaveIn);
        outEl.addEventListener('dragenter', onDragEnterOut);
        outEl.addEventListener('dragleave', onDragLeaveOut);
        inEl.addEventListener('drop', onDropIn);
        outEl.addEventListener('drop', onDropOut);
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        dlg.addEventListener('close', onClose, { once: true });
        if (typeof dlg.showModal === 'function') dlg.showModal();
    });
}
