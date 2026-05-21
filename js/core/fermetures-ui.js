/**
 * Indisponibilités / fermetures : périodes brouillon → application (créneaux + décalage prof).
 */
import { isAdmin, isProf } from './auth-logic.js';
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
    formatConflictLineFr
} from './fermetures-planning.js';
import {
    deleteAbsencePeriodDraft,
    loadAllAbsencePeriodsForUi,
    pendingAbsencePeriodsForUser,
    saveAbsencePeriodDraft
} from './absence-period-db.js';
import { applyPendingAbsencePeriods } from './absence-apply-engine.js';
import {
    fetchOrganSchoolSettings,
    getSchoolYearBoundsFromSettings
} from './organ-settings.js';
import { syncPlanningDrawerGroupedSections } from './planning-drawer-ui.js';

let bound = false;

/** @type {import('./absence-period-db.js').AbsencePeriodRow[]} */
let closureRanges = [];

/** @type {number | null} */
let editingClosureIndex = null;

/** @type {object[]} */
let pendingConflicts = [];

let closureSaveInFlight = false;
let closureApplyInFlight = false;

/** @type {import('./absence-period-db.js').AbsencePeriodRow[] | null} */
let closureRangesBeforeOptimistic = null;

export function canViewClosures(user) {
    if (!Boolean(user?.email) || !isBackendAuthConfigured()) return false;
    return isProf(user) || isAdmin(user);
}

export function canManageOwnClosures(user) {
    return canViewClosures(user);
}

function ownsClosurePeriod(range, user) {
    return String(range?.createdByUserId || '') === String(user?.id || '');
}

function canEditClosureRange(range, user) {
    if (!canManageOwnClosures(user)) return false;
    if (range?.legacy) return false;
    if (range?.appliedAt) return false;
    const ownerId = String(range?.createdByUserId || '').trim();
    if (!ownerId) return true;
    return ownsClosurePeriod(range, user);
}

function canDeleteClosureRange(range, user) {
    if (!canViewClosures(user)) return false;
    if (range?.legacy) {
        return isAdmin(user) || ownsClosurePeriod(range, user);
    }
    return canEditClosureRange(range, user);
}

function todayYmdLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function closureCardToneClass(range) {
    if (range?.creatorRole === 'admin') return 'fermeture-card--admin';
    if (range?.creatorRole === 'prof') return 'fermeture-card--prof';
    return '';
}

function setFermeturesModalBusy(busy) {
    const dlg = document.getElementById('modal_fermetures');
    dlg?.classList.toggle('fermetures-modal--busy', busy);
    const progWrap = document.getElementById('fermetures-apply-progress-wrap');
    if (busy) {
        progWrap?.classList.remove('hidden');
        progWrap?.setAttribute('aria-hidden', 'false');
    } else {
        progWrap?.classList.add('hidden');
        progWrap?.setAttribute('aria-hidden', 'true');
    }
}

function setApplyProgress(pct, label) {
    const bar = document.getElementById('fermetures-apply-progress');
    const lab = document.getElementById('fermetures-apply-progress-label');
    if (bar instanceof HTMLProgressElement) bar.value = Math.max(0, Math.min(100, pct));
    if (lab) lab.textContent = label || 'Application…';
}

function isClosurePeriodFullyPast(range) {
    const end = String(range?.endYmd || '').slice(0, 10);
    return Boolean(end && end < todayYmdLocal());
}

function syncFermeturesActionsRow() {
    const u = getPlanningSessionUser();
    const row = document.getElementById('fermetures-actions-row');
    const applyBtn = document.getElementById('fermetures-apply-pending');
    const addBtn = document.getElementById('fermetures-add');
    const fabWrap = document.getElementById('fermetures-fab-wrap');
    if (!row) return;
    const canManage = canManageOwnClosures(u);
    row.classList.toggle('hidden', !canManage);
    const editOpen = !document.getElementById('fermetures-edit-panel')?.classList.contains('hidden');
    fabWrap?.classList.toggle('hidden', !canManage || editOpen);
    const pending = pendingAbsencePeriodsForUser(closureRanges, u);
    if (applyBtn instanceof HTMLButtonElement) {
        applyBtn.classList.toggle('hidden', !pending.length);
        applyBtn.textContent =
            pending.length === 1
                ? 'Appliquer 1 absence'
                : `Appliquer ${pending.length} absences`;
        applyBtn.disabled = closureApplyInFlight;
    }
    if (addBtn instanceof HTMLButtonElement) {
        addBtn.disabled = closureApplyInFlight || closureSaveInFlight;
    }
}

function buildClosureCard(range, index) {
    const u = getPlanningSessionUser();
    const isPast = isClosurePeriodFullyPast(range);
    const editable = canEditClosureRange(range, u) && !isPast;
    const pending = Boolean(range._optimistic);
    const isDraft = !range.appliedAt && !range.legacy;
    const card = document.createElement('div');
    card.className = `fermeture-card rounded-xl border px-3 py-2.5 min-w-0 ${closureCardToneClass(range)}${isPast ? ' fermeture-card--past' : ''}`;
    if (!pending && !closureApplyInFlight) {
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

    const body = document.createElement('div');
    body.className = 'flex-1 min-w-0';
    const dates = document.createElement('p');
    dates.className = 'text-[12px] font-mono font-semibold text-slate-800 dark:text-slate-50 m-0 leading-snug';
    dates.textContent = pending
        ? `${formatFrRange(range.startYmd, range.endYmd)} — enregistrement…`
        : formatFrRange(range.startYmd, range.endYmd);
    body.appendChild(dates);

    const meta = document.createElement('p');
    meta.className = 'text-[10px] text-slate-600 dark:text-slate-300 m-0 mt-0.5';
    meta.textContent = range.creatorLabel || (range.creatorRole === 'admin' ? 'Administration' : 'Professeur');
    body.appendChild(meta);

    const titleText = String(range.title || '').trim();
    if (titleText) {
        const title = document.createElement('p');
        title.className =
            'text-[11px] text-slate-600 dark:text-orange-100/90 m-0 mt-0.5 leading-snug break-words';
        title.textContent = titleText;
        body.appendChild(title);
    }

    const badge = document.createElement('span');
    badge.className = `fermeture-card__badge ${isDraft ? 'fermeture-card__badge--draft' : 'fermeture-card__badge--applied'}`;
    badge.textContent = isDraft ? 'À appliquer' : 'Appliquée';
    body.appendChild(badge);

    card.appendChild(body);

    const deletable = canDeleteClosureRange(range, u) && !isPast;
    if (!deletable || pending || closureApplyInFlight) return card;

    card.classList.add('fermeture-card--with-delete');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'fermeture-card__delete-btn';
    delBtn.setAttribute('aria-label', 'Supprimer cette période');
    delBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916A2.25 2.25 0 0013.5 2.25h-3A2.25 2.25 0 008.25 4.5v.916m7.5 0a48.11 48.11 0 01-7.5 0" /></svg>';
    delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!window.confirm('Supprimer cette période ?')) return;
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

    if (!closureRanges.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-500 dark:text-slate-400 italic m-0 py-2';
        empty.textContent = canManageOwnClosures(u)
            ? 'Aucune période enregistrée pour l’année scolaire en cours.'
            : 'Aucune période sur l’année en cours.';
        host.appendChild(empty);
        syncFermeturesActionsRow();
        return;
    }

    closureRanges.forEach((r, index) => {
        host.appendChild(buildClosureCard(r, index));
    });
    syncFermeturesActionsRow();
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
    document.getElementById('fermetures-fab-wrap')?.classList.remove('hidden');
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
    closureSaveInFlight = busy;
    const saveBtn = document.getElementById('fermeture-edit-save');
    if (saveBtn instanceof HTMLButtonElement) {
        saveBtn.disabled = busy || closureApplyInFlight;
        saveBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    syncFermeturesActionsRow();
}

function openClosureEdit(index) {
    const u = getPlanningSessionUser();
    if (!canViewClosures(u)) return;
    if (closureRanges[index]?._optimistic || closureApplyInFlight) return;
    const rangeRef = index >= 0 ? closureRanges[index] : null;
    const isPast = rangeRef ? isClosurePeriodFullyPast(rangeRef) : false;
    const editable = rangeRef ? canEditClosureRange(rangeRef, u) && !isPast : true;
    editingClosureIndex = index;
    document.getElementById('fermetures-fab-wrap')?.classList.add('hidden');
    const range =
        index >= 0
            ? closureRanges[index]
            : { startYmd: todayYmdLocal(), endYmd: todayYmdLocal(), title: '', eventIds: [] };

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
    pushPlanningRouteLevel('modal_fermetures', title, 'Fermetures / Indisponibilités', showFermeturesMainPanel);
}

async function persistClosureEdit() {
    if (closureSaveInFlight || closureApplyInFlight) return;
    const u = getPlanningSessionUser();
    if (!canManageOwnClosures(u)) return;
    const f = readEditForm();
    if (!f.startYmd || !f.endYmd) {
        showToast('Indiquez les dates de début et de fin.', 'error');
        return;
    }
    if (f.endYmd < f.startYmd) {
        showToast('La date de fin doit être après le début.', 'error');
        return;
    }
    if (f.endYmd < todayYmdLocal()) {
        showToast('La période ne peut pas être entièrement dans le passé.', 'error');
        return;
    }

    const prev =
        editingClosureIndex != null && editingClosureIndex >= 0
            ? closureRanges[editingClosureIndex]
            : null;

    setClosureSaveBusy(true);
    const r = await saveAbsencePeriodDraft({
        id: prev?.legacy ? undefined : prev?.id,
        startYmd: f.startYmd,
        endYmd: f.endYmd,
        title: f.title
    });
    setClosureSaveBusy(false);
    if (!r.ok || !r.period) {
        showToast(r.error || 'Enregistrement impossible.', 'error');
        return;
    }

    returnToFermeturesList();
    await loadClosureRangesFromServer();
    showToast('Période enregistrée. Utilisez « Appliquer » pour la publier.', 'success');
}

async function collectConflictsForPendingApply() {
    const u = getPlanningSessionUser();
    const pending = pendingAbsencePeriodsForUser(closureRanges, u);
    /** @type {object[]} */
    const all = [];
    /** @type {Map<string, object[]>} */
    const byPeriod = new Map();
    for (const p of pending) {
        const conflicts = await findConflictsForClosureRange(p.startYmd, p.endYmd, []);
        if (conflicts.length) byPeriod.set(p.id, conflicts);
        for (const c of conflicts) {
            if (!all.some((x) => x.id === c.id)) all.push(c);
        }
    }
    return { all, byPeriod };
}

async function runApplyPendingClosures(deleteConflicts) {
    if (closureApplyInFlight) return;
    const u = getPlanningSessionUser();
    const pending = pendingAbsencePeriodsForUser(closureRanges, u);
    if (!pending.length) {
        showToast('Aucune nouvelle période à appliquer.', 'info');
        return;
    }

    closureApplyInFlight = true;
    setFermeturesModalBusy(true);
    setApplyProgress(0, 'Préparation…');
    syncFermeturesActionsRow();
    renderClosureCards();

    let conflictsByPeriod = new Map();
    if (!deleteConflicts) {
        const { all, byPeriod } = await collectConflictsForPendingApply();
        if (all.length) {
            closureApplyInFlight = false;
            setFermeturesModalBusy(false);
            syncFermeturesActionsRow();
            renderClosureCards();
            showConflictPanel(all);
            window.__fermeturesApplyConflictMap = byPeriod;
            return;
        }
        conflictsByPeriod = byPeriod;
    } else {
        conflictsByPeriod = window.__fermeturesApplyConflictMap || new Map();
        hideConflictPanel();
    }

    const r = await applyPendingAbsencePeriods(closureRanges, {
        deleteConflicts,
        conflictsByPeriodId: conflictsByPeriod,
        onProgress: (pct, label) => setApplyProgress(pct, label)
    });

    closureApplyInFlight = false;
    setFermeturesModalBusy(false);
    window.__fermeturesApplyConflictMap = null;
    syncFermeturesActionsRow();

    if (!r.ok) {
        showToast(r.error || 'Application impossible.', 'error', 8000);
        await loadClosureRangesFromServer();
        renderClosureCards();
        return;
    }

    invalidateCalendarListCache();
    document.dispatchEvent(new CustomEvent('planning-events-changed'));
    await loadClosureRangesFromServer();
    renderClosureCards();
    showToast(
        r.applied === 1
            ? 'Absence appliquée (fermetures + décalage si nécessaire).'
            : `${r.applied} absences appliquées.`,
        'success'
    );
}

function setConflictProceedBusy(busy) {
    const proceed = document.getElementById('fermetures-conflict-proceed');
    const cancel = document.getElementById('fermetures-conflict-cancel');
    if (proceed instanceof HTMLButtonElement) proceed.disabled = busy;
    if (cancel instanceof HTMLButtonElement) cancel.disabled = busy;
}

function returnToFermeturesList() {
    hideConflictPanel();
    editingClosureIndex = null;
    showFermeturesMainPanel();
    popPlanningRouteLevel('modal_fermetures');
}

async function deleteClosureAt(index) {
    const u = getPlanningSessionUser();
    const range = closureRanges[index];
    if (!range || !canDeleteClosureRange(range, u)) return;

    if (range.legacy) {
        const r = await deleteClosureRangeEvents(range.eventIds);
        if (!r.ok) {
            showToast(r.error || 'Suppression impossible.', 'error');
            return;
        }
    } else {
        const r = await deleteAbsencePeriodDraft(range.id);
        if (!r.ok) {
            showToast(r.error || 'Suppression impossible.', 'error');
            return;
        }
    }

    closureRanges.splice(index, 1);
    renderClosureCards();
    showToast('Période supprimée.', 'success');
    invalidateCalendarListCache();
    document.dispatchEvent(new CustomEvent('planning-events-changed'));
}

export async function loadClosureRangesFromServer() {
    closureRanges = await loadAllAbsencePeriodsForUi();
}

export async function openFermeturesModal() {
    const u = getPlanningSessionUser();
    if (!canViewClosures(u)) {
        showToast('Indisponibilités : réservé aux professeurs et administrateurs.', 'info');
        return;
    }
    await fetchOrganSchoolSettings();
    await loadClosureRangesFromServer();
    showFermeturesMainPanel();
}

export function syncFermeturesMenuVisibility(user) {
    const show = canViewClosures(user);
    document.getElementById('menu-item-fermetures-wrap')?.classList.toggle('hidden', !show);
    syncPlanningDrawerGroupedSections();
}

export function resetFermeturesUiBindings() {
    bound = false;
    closureRanges = [];
    editingClosureIndex = null;
    pendingConflicts = [];
    closureSaveInFlight = false;
    closureApplyInFlight = false;
    closureRangesBeforeOptimistic = null;
}

export function initFermeturesUi() {
    if (!isBackendAuthConfigured() || bound) return;
    bound = true;

    document.getElementById('menu-item-fermetures')?.addEventListener('click', (e) => {
        e.preventDefault();
        const u = getPlanningSessionUser();
        if (!canViewClosures(u)) {
            showToast('Indisponibilités : réservé aux professeurs et administrateurs.', 'info');
            return;
        }
        if (!openPlanningRouteFromDrawer('modal_fermetures', 'Fermetures / Indisponibilités', 'Menu')) return;
        void openFermeturesModal();
    });

    document.getElementById('fermetures-add')?.addEventListener('click', () => {
        if (closureApplyInFlight) return;
        openClosureEdit(-1);
    });

    document.getElementById('fermetures-apply-pending')?.addEventListener('click', () => {
        void runApplyPendingClosures(false);
    });

    document.getElementById('fermeture-edit-save')?.addEventListener('click', () => {
        void persistClosureEdit();
    });

    document.getElementById('fermetures-conflict-cancel')?.addEventListener('click', () => {
        hideConflictPanel();
    });

    document.getElementById('fermetures-conflict-proceed')?.addEventListener('click', () => {
        setConflictProceedBusy(true);
        void runApplyPendingClosures(true).finally(() => setConflictProceedBusy(false));
    });

    document.getElementById('modal_fermetures')?.addEventListener('close', () => {
        showFermeturesMainPanel();
    });
}

/** Conservé pour compat (semaines types). */
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
