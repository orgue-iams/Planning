/**
 * Menu Fermetures : vue synthétique sur les créneaux planning (slot_type = fermeture).
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';
import {
    openPlanningRouteFromDrawer,
    planningRouteTitle,
    popPlanningRouteLevel,
    pushPlanningRouteLevel
} from '../utils/planning-route-dialog.js';
import { invalidateCalendarListCache } from './calendar-events-list-cache.js';
import {
    deleteClosureRangeEvents,
    findConflictsForClosureRange,
    formatConflictLineFr,
    loadClosureRangesFromPlanning,
    saveClosureRangeToPlanning
} from './fermetures-planning.js';

let bound = false;

/** @type {{ startYmd: string, endYmd: string, title?: string, eventIds: string[] }[]} */
let closureRanges = [];

/** @type {number | null} */
let editingClosureIndex = null;

/** @type {object[]} */
let pendingConflicts = [];

let closureSaveInFlight = false;

/** @type {{ startYmd: string, endYmd: string, title?: string, eventIds: string[] }[] | null} */
let closureRangesBeforeOptimistic = null;

function canViewClosures(user) {
    return Boolean(user?.email) && isBackendAuthConfigured();
}

function canEditClosures(user) {
    return isAdmin(user);
}

/** Conservé pour compat (semaines types n’utilise plus les réglages JSON). */
export function parseClosureRangesFromSettings(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const startYmd = String(item.startYmd || item.start || '').trim();
        const endYmd = String(item.endYmd || item.end || '').trim();
        const title = String(item.title || '').trim();
        if (startYmd && endYmd && endYmd >= startYmd) {
            out.push({ startYmd, endYmd, ...(title ? { title } : {}), eventIds: [] });
        }
    }
    return out;
}

function formatFrRange(startYmd, endYmd) {
    const s = new Date(`${startYmd}T12:00:00`);
    const e = new Date(`${endYmd}T12:00:00`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
        return `${startYmd} → ${endYmd}`;
    }
    const opts = { day: 'numeric', month: 'long', year: 'numeric' };
    if (startYmd === endYmd) return s.toLocaleDateString('fr-FR', opts);
    return `${s.toLocaleDateString('fr-FR', opts)} → ${e.toLocaleDateString('fr-FR', opts)}`;
}

function todayYmdLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function futureClosureRanges() {
    const today = todayYmdLocal();
    return closureRanges.filter((r) => String(r.endYmd || '') >= today);
}

function closureRangesOverlap(a, b) {
    return String(a.endYmd) >= String(b.startYmd) && String(a.startYmd) <= String(b.endYmd);
}

function cloneClosureRanges(list) {
    return (list || []).map((r) => ({
        startYmd: r.startYmd,
        endYmd: r.endYmd,
        title: r.title,
        eventIds: [...(r.eventIds || [])],
        ...(r._optimistic ? { _optimistic: true } : {})
    }));
}

/** Affiche tout de suite la période dans la liste (avant fin base / Google). */
function applyOptimisticClosureRange(entry, prevIndex) {
    closureRangesBeforeOptimistic = cloneClosureRanges(closureRanges);
    const keep = closureRanges.filter((r, i) => {
        if (prevIndex != null && prevIndex >= 0 && i === prevIndex) return false;
        return !closureRangesOverlap(r, entry);
    });
    closureRanges = [
        ...keep,
        {
            startYmd: entry.startYmd,
            endYmd: entry.endYmd,
            title: entry.title,
            eventIds: [...(entry.eventIds || [])],
            _optimistic: true
        }
    ].sort((a, b) => a.startYmd.localeCompare(b.startYmd));
}

function revertOptimisticClosureRange() {
    if (!closureRangesBeforeOptimistic) return;
    closureRanges = closureRangesBeforeOptimistic;
    closureRangesBeforeOptimistic = null;
}

function buildClosureCard(range, index, editable) {
    const pending = Boolean(range._optimistic);
    const card = document.createElement('div');
    card.className =
        'fermeture-card rounded-xl border border-orange-200/80 bg-orange-50/95 dark:border-orange-700/50 dark:bg-orange-950/45 px-3 py-2.5 min-w-0';
    if (!pending) {
        card.classList.add('cursor-pointer');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.addEventListener('click', () => openClosureEdit(index));
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openClosureEdit(index);
            }
        });
    } else {
        card.classList.add('fermeture-card--pending');
        card.setAttribute('aria-busy', 'true');
    }
    card.dataset.closureIndex = String(index);

    const body = document.createElement('div');
    body.className = 'flex-1 min-w-0';
    const dates = document.createElement('p');
    dates.className = 'text-[12px] font-mono font-semibold text-slate-800 dark:text-orange-50 m-0 leading-snug';
    dates.textContent = pending
        ? `${formatFrRange(range.startYmd, range.endYmd)} — enregistrement…`
        : formatFrRange(range.startYmd, range.endYmd);
    const title = document.createElement('p');
    title.className = 'text-[11px] text-slate-600 dark:text-orange-100/90 m-0 mt-0.5 leading-snug break-words';
    body.appendChild(dates);
    const titleText = String(range.title || '').trim();
    if (titleText) {
        title.textContent = titleText;
        body.appendChild(title);
    }
    card.appendChild(body);

    if (!editable || pending) return card;

    card.classList.add('fermeture-card--with-delete');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'fermeture-card__delete-btn';
    delBtn.setAttribute('aria-label', 'Supprimer cette période de fermeture');
    delBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916A2.25 2.25 0 0013.5 2.25h-3A2.25 2.25 0 008.25 4.5v.916m7.5 0a48.11 48.11 0 01-7.5 0" /></svg>';
    delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!window.confirm('Supprimer cette période de fermeture ?')) return;
        void deleteClosureAt(index);
    });
    card.appendChild(delBtn);
    return card;
}

function renderClosureCards() {
    const host = document.getElementById('fermetures-list');
    if (!host) return;
    host.replaceChildren();
    const u = getPlanningSessionUser();
    const editable = canEditClosures(u);
    const visible = futureClosureRanges();

    if (!visible.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-500 dark:text-slate-400 italic m-0 py-2';
        empty.textContent = editable
            ? 'Aucune période. Utilisez « + Période de fermeture ».'
            : 'Aucune période de fermeture définie.';
        host.appendChild(empty);
        return;
    }

    visible.forEach((r) => {
        const index = closureRanges.indexOf(r);
        host.appendChild(buildClosureCard(r, index, editable));
    });
}

function hideConflictPanel() {
    pendingConflicts = [];
    const panel = document.getElementById('fermetures-conflict-panel');
    panel?.classList.add('hidden');
    panel?.setAttribute('aria-hidden', 'true');
}

function showConflictPanel(conflicts) {
    pendingConflicts = conflicts;
    const panel = document.getElementById('fermetures-conflict-panel');
    const list = document.getElementById('fermetures-conflict-list');
    if (!panel || !list) return;
    list.replaceChildren();
    for (const c of conflicts) {
        const li = document.createElement('li');
        li.className = 'text-[11px] leading-snug text-slate-700 dark:text-slate-200';
        li.textContent = formatConflictLineFr(c);
        list.appendChild(li);
    }
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
}

function showFermeturesMainPanel() {
    document.getElementById('fermetures-main-panel')?.classList.remove('hidden');
    const edit = document.getElementById('fermetures-edit-panel');
    edit?.classList.add('hidden');
    edit?.setAttribute('aria-hidden', 'true');
    hideConflictPanel();
    editingClosureIndex = null;
    renderClosureCards();
}

function readEditForm() {
    return {
        startYmd: String(document.getElementById('fermeture-edit-start')?.value || '').trim(),
        endYmd: String(document.getElementById('fermeture-edit-end')?.value || '').trim(),
        title: String(document.getElementById('fermeture-edit-title')?.value || '').trim()
    };
}

function applyEditForm(range) {
    const s = document.getElementById('fermeture-edit-start');
    const e = document.getElementById('fermeture-edit-end');
    const t = document.getElementById('fermeture-edit-title');
    if (s instanceof HTMLInputElement) s.value = range?.startYmd || '';
    if (e instanceof HTMLInputElement) e.value = range?.endYmd || '';
    if (t instanceof HTMLInputElement) t.value = range?.title || '';
}

function setEditFieldsReadonly(readonly) {
    for (const id of ['fermeture-edit-start', 'fermeture-edit-end', 'fermeture-edit-title']) {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement) {
            el.readOnly = readonly;
            el.disabled = readonly;
            el.classList.toggle('opacity-70', readonly);
        }
    }
    const saveBtn = document.getElementById('fermeture-edit-save');
    if (saveBtn instanceof HTMLButtonElement) saveBtn.classList.toggle('hidden', readonly);
}

function setClosureSaveBusy(busy) {
    const saveBtn = document.getElementById('fermeture-edit-save');
    if (saveBtn instanceof HTMLButtonElement) {
        saveBtn.disabled = busy;
        saveBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
}

function openClosureEdit(index) {
    const u = getPlanningSessionUser();
    if (!canViewClosures(u)) return;
    if (closureRanges[index]?._optimistic) return;
    const editable = canEditClosures(u);
    editingClosureIndex = index;
    const range =
        index >= 0
            ? closureRanges[index]
            : { startYmd: '', endYmd: '', title: '', eventIds: [] };

    document.getElementById('fermetures-main-panel')?.classList.add('hidden');
    const panel = document.getElementById('fermetures-edit-panel');
    panel?.classList.remove('hidden');
    panel?.setAttribute('aria-hidden', 'false');
    hideConflictPanel();

    applyEditForm(range);
    setEditFieldsReadonly(!editable);

    const title =
        index < 0
            ? planningRouteTitle('Nouvelle période')
            : editable
              ? planningRouteTitle('Édition')
              : planningRouteTitle('Détail');
    pushPlanningRouteLevel('modal_fermetures', title, 'Fermetures', showFermeturesMainPanel);
}

async function persistClosureEdit(deleteConflicts) {
    if (closureSaveInFlight) return;
    const u = getPlanningSessionUser();
    if (!canEditClosures(u)) return;
    const f = readEditForm();
    if (!f.startYmd || !f.endYmd) {
        showToast('Indiquez les dates de début et de fin.', 'error');
        return;
    }
    if (f.endYmd < f.startYmd) {
        showToast('La date de fin doit être après le début.', 'error');
        return;
    }

    const prev =
        editingClosureIndex != null && editingClosureIndex >= 0
            ? closureRanges[editingClosureIndex]
            : { eventIds: [] };
    const excludeIds = deleteConflicts ? [] : [...(prev.eventIds || [])];

    if (!deleteConflicts) {
        closureSaveInFlight = true;
        setClosureSaveBusy(true);
    }
    let conflicts = [];
    try {
        conflicts = await findConflictsForClosureRange(f.startYmd, f.endYmd, excludeIds);
    } catch (err) {
        if (!deleteConflicts) {
            closureSaveInFlight = false;
            setClosureSaveBusy(false);
        }
        throw err;
    }
    if (conflicts.length && !deleteConflicts) {
        closureSaveInFlight = false;
        setClosureSaveBusy(false);
        showConflictPanel(conflicts);
        return;
    }

    const entry = {
        startYmd: f.startYmd,
        endYmd: f.endYmd,
        title: f.title,
        eventIds: [...(prev.eventIds || [])]
    };
    const prevIndex = editingClosureIndex;

    applyOptimisticClosureRange(entry, prevIndex);
    returnToFermeturesList();
    showToast('Enregistrement de la période en cours…', 'info', 2800);

    closureSaveInFlight = true;
    setClosureSaveBusy(false);
    setConflictProceedBusy(true);
    try {
        const r = await saveClosureRangeToPlanning(entry, {
            deleteConflicts: Boolean(deleteConflicts && conflicts.length),
            conflicts: deleteConflicts ? conflicts : []
        });
        if (!r.ok) {
            revertOptimisticClosureRange();
            renderClosureCards();
            showToast(r.error || 'Enregistrement impossible.', 'error', 8000);
            return;
        }

        closureRangesBeforeOptimistic = null;
        invalidateCalendarListCache();
        document.dispatchEvent(new CustomEvent('planning-events-changed'));
        await loadClosureRangesFromServer();
        renderClosureCards();
        const n = conflicts.length;
        showToast(
            deleteConflicts && n
                ? `Période enregistrée. ${n} créneau(x) supprimé(s).`
                : 'Période de fermeture enregistrée.',
            'success'
        );
    } finally {
        closureSaveInFlight = false;
        setConflictProceedBusy(false);
    }
}

function setConflictProceedBusy(busy) {
    const proceed = document.getElementById('fermetures-conflict-proceed');
    const cancel = document.getElementById('fermetures-conflict-cancel');
    if (proceed instanceof HTMLButtonElement) proceed.disabled = busy;
    if (cancel instanceof HTMLButtonElement) cancel.disabled = busy;
}

/** Retour liste Fermetures (quitte création / édition / conflits). */
function returnToFermeturesList() {
    hideConflictPanel();
    editingClosureIndex = null;
    showFermeturesMainPanel();
    popPlanningRouteLevel('modal_fermetures');
}

async function deleteClosureAt(index) {
    const u = getPlanningSessionUser();
    if (!canEditClosures(u)) return;
    if (index < 0 || index >= closureRanges.length) return;
    const range = closureRanges[index];
    const snapshot = {
        startYmd: range.startYmd,
        endYmd: range.endYmd,
        title: range.title,
        eventIds: [...(range.eventIds || [])]
    };
    const eventIds = snapshot.eventIds;

    closureRanges.splice(index, 1);
    if (editingClosureIndex === index) {
        editingClosureIndex = null;
    } else if (editingClosureIndex != null && editingClosureIndex > index) {
        editingClosureIndex -= 1;
    }
    renderClosureCards();
    showToast('Période de fermeture supprimée.', 'success');

    const r = await deleteClosureRangeEvents(eventIds);
    if (!r.ok) {
        closureRanges.splice(index, 0, snapshot);
        renderClosureCards();
        showToast(r.error || 'Suppression impossible.', 'error');
        return;
    }
    invalidateCalendarListCache();
    document.dispatchEvent(new CustomEvent('planning-events-changed'));
    void loadClosureRangesFromServer().then(() => renderClosureCards());
}

export async function loadClosureRangesFromServer() {
    closureRanges = await loadClosureRangesFromPlanning();
}

export async function openFermeturesModal() {
    const u = getPlanningSessionUser();
    if (!canViewClosures(u)) {
        showToast('Connectez-vous pour consulter les fermetures.', 'info');
        return;
    }
    await loadClosureRangesFromServer();
    showFermeturesMainPanel();
    document.getElementById('fermetures-add-wrap')?.classList.toggle('hidden', !canEditClosures(u));
}

export function resetFermeturesUiBindings() {
    bound = false;
    closureRanges = [];
    editingClosureIndex = null;
    pendingConflicts = [];
    closureSaveInFlight = false;
    closureRangesBeforeOptimistic = null;
}

export function initFermeturesUi() {
    if (!isBackendAuthConfigured() || bound) return;
    bound = true;

    document.getElementById('menu-item-fermetures')?.addEventListener('click', (e) => {
        e.preventDefault();
        const u = getPlanningSessionUser();
        if (!canViewClosures(u)) {
            showToast('Fermetures : connexion requise.', 'info');
            return;
        }
        if (!openPlanningRouteFromDrawer('modal_fermetures', 'Fermetures', 'Menu')) return;
        void openFermeturesModal();
    });

    document.getElementById('fermetures-add')?.addEventListener('click', () => {
        openClosureEdit(-1);
    });

    document.getElementById('fermeture-edit-save')?.addEventListener('click', () => {
        void persistClosureEdit(false);
    });

    document.getElementById('fermeture-edit-cancel')?.addEventListener('click', () => {
        returnToFermeturesList();
    });

    document.getElementById('fermetures-conflict-cancel')?.addEventListener('click', () => {
        hideConflictPanel();
    });

    document.getElementById('fermetures-conflict-proceed')?.addEventListener('click', () => {
        void persistClosureEdit(true);
    });

    document.getElementById('modal_fermetures')?.addEventListener('close', () => {
        showFermeturesMainPanel();
    });
}
