/**
 * Modale unique : allocation élèves ↔ créneau « cours » (semaines types + réservation).
 * @typedef {{ user_id: string, nom?: string, prenom?: string, email?: string }} EleveRow
 */

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
            `<button type="button" class="csp-student-row btn btn-ghost btn-sm h-auto min-h-0 py-1.5 px-2 text-left text-[11px] font-normal font-sans w-full justify-start border border-transparent hover:border-slate-200" data-user-id="${escapeAttr(id)}">${escapeAttr(label)}</button>`;
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

    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            inEl.removeEventListener('click', onRowClick);
            outEl.removeEventListener('click', onRowClick);
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
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        dlg.addEventListener('close', onClose, { once: true });
        if (typeof dlg.showModal === 'function') dlg.showModal();
    });
}
