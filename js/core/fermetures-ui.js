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
    pushPlanningRouteLevel
} from '../utils/planning-route-dialog.js';
import { invalidateCalendarListCache } from './calendar-events-list-cache.js';
import {
    deleteClosureRangeEvents,
    findConflictsForClosurePeriod,
    formatConflictLineFr
} from './fermetures-planning.js';
import {
    deleteAbsencePeriodDraft,
    deleteAbsencePeriodOwned,
    fetchEventIdsForAbsencePeriod,
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
import { createPlanningIconDeleteButton } from '../utils/planning-delete-btn.js';
import { planningConfirm } from '../utils/planning-confirm.js';
import {
    CLOSURE_PERIODIC_ICON_SVG,
    formatPeriodicClosureLabel
} from '../utils/closure-period-helpers.js';
import { openFermetureEdit } from './fermeture-edit-ui.js';

let bound = false;

const FERMETURE_CALENDAR_ICON_SVG =
    '<svg class="fermeture-card__cal-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>';

/** @type {import('./absence-period-db.js').AbsencePeriodRow[]} */
let closureRanges = [];

/** @type {number | null} */

/** @type {object[]} */
let pendingConflicts = [];

let closureApplyInFlight = false;
let fermeturesOwnOnlyFilter = false;

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

export function canEditClosureRange(range, user) {
    if (!canManageOwnClosures(user)) return false;
    if (range?.legacy) return false;
    if (isAdmin(user)) return true;
    const ownerId = String(range?.createdByUserId || '').trim();
    if (!ownerId) return true;
    return ownsClosurePeriod(range, user);
}

function isClosureDraftPast(range) {
    return isClosurePeriodFullyPast(range) && !range?.appliedAt && !range?.legacy;
}

export function canDeleteClosureRange(range, user) {
    if (!canViewClosures(user)) return false;
    if (range?.legacy) {
        return isAdmin(user) || ownsClosurePeriod(range, user);
    }
    if (isAdmin(user)) return true;
    if (ownsClosurePeriod(range, user)) return true;
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
    const opts = { day: 'numeric', month: 'short' };
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
    if (bar instanceof HTMLProgressElement && typeof pct === 'number' && Number.isFinite(pct)) {
        bar.value = Math.max(0, Math.min(100, pct));
    }
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
    const hasPendingDrafts = closureRanges.some((r) => !r.legacy && !r.appliedAt);
    row?.classList.toggle('hidden', !canManage || !hasPendingDrafts);
    const editOpen = Boolean(document.getElementById('modal_fermeture_edit')?.open);
    fabWrap?.classList.toggle('hidden', !canManage || editOpen);
    const pending = pendingAbsencePeriodsForUser(closureRanges, u);
    const today = todayYmdLocal();
    const applicablePending = pending.filter((p) => String(p.endYmd || '').slice(0, 10) >= today);
    if (applyBtn instanceof HTMLButtonElement) {
        applyBtn.classList.toggle('hidden', !applicablePending.length);
        applyBtn.textContent =
            applicablePending.length === 1
                ? 'Appliquer 1 absence'
                : `Appliquer ${applicablePending.length} absences`;
        applyBtn.disabled = closureApplyInFlight;
    }
    if (addBtn instanceof HTMLButtonElement) {
        addBtn.disabled = closureApplyInFlight;
    }
}

function ownsClosureRange(range, user) {
    return String(range?.createdByUserId || '') === String(user?.id || '');
}

function buildClosureCard(range, index) {
    const u = getPlanningSessionUser();
    const isPast = isClosurePeriodFullyPast(range);
    const editable = canEditClosureRange(range, u) && !isPast;
    const pending = Boolean(range._optimistic);
    const isDraft = !range.appliedAt && !range.legacy;
    const draftPast = isDraft && isPast;
    const mine = ownsClosureRange(range, u);
    const deletable = canDeleteClosureRange(range, u) && !isPast && !pending && !closureApplyInFlight;
    const card = document.createElement('div');
    card.className = `fermeture-card fermeture-card--layout-grid rounded-xl border px-3 py-2.5 min-w-0 ${closureCardToneClass(range)}${isPast ? ' fermeture-card--past' : ''}${mine ? ' fermeture-card--mine' : ''}${deletable ? ' fermeture-card--with-delete' : ''}`;
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

    const grid = document.createElement('div');
    grid.className = 'fermeture-card__grid min-w-0';

    const left = document.createElement('div');
    left.className = 'fermeture-card__col-left min-w-0';
    const periodLine = document.createElement('div');
    periodLine.className = 'fermeture-card__period-line flex items-center gap-1 min-w-0';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'fermeture-card__cal-icon-wrap shrink-0 text-slate-600';
    iconWrap.innerHTML = range.isPeriodic ? CLOSURE_PERIODIC_ICON_SVG : FERMETURE_CALENDAR_ICON_SVG;
    const dates = document.createElement('p');
    dates.className =
        'text-[11px] font-semibold text-slate-800 m-0 leading-snug break-words whitespace-normal';
    let periodLabel = pending
        ? `${formatFrRange(range.startYmd, range.endYmd)} — enregistrement…`
        : formatFrRange(range.startYmd, range.endYmd);
    if (range.isPeriodic && !pending) {
        periodLabel = formatPeriodicClosureLabel(range.weekdays);
    }
    dates.textContent = periodLabel;
    periodLine.appendChild(iconWrap);
    periodLine.appendChild(dates);
    left.appendChild(periodLine);
    const titleText = String(range.title || '').trim();
    const title = document.createElement('p');
    title.className =
        'text-[11px] font-normal text-slate-800 m-0 mt-0.5 leading-snug break-words';
    title.textContent = titleText || 'Fermeture';
    left.appendChild(title);
    grid.appendChild(left);

    const center = document.createElement('div');
    center.className = 'fermeture-card__col-center min-w-0 flex flex-col justify-start gap-0.5';
    const creator = document.createElement('p');
    creator.className =
        'fermeture-card__creator text-[11px] font-normal text-slate-800 m-0 leading-snug break-words';
    creator.textContent =
        range.creatorLabel || (range.creatorRole === 'admin' ? 'Administration' : 'Professeur');
    center.appendChild(creator);
    const badge = document.createElement('span');
    badge.className = `fermeture-card__badge ${isDraft ? 'fermeture-card__badge--draft' : 'fermeture-card__badge--applied'}`;
    badge.textContent = isDraft ? (draftPast ? 'Archivée (non applicable)' : 'À appliquer') : 'Appliquée';
    center.appendChild(badge);
    grid.appendChild(center);

    if (deletable) {
        const actions = document.createElement('div');
        actions.className = 'fermeture-card__col-actions shrink-0 flex items-start justify-center pt-0.5';
        actions.appendChild(
            createPlanningIconDeleteButton({
                ariaLabel: 'Supprimer cette période',
                title: 'Supprimer',
                onClick: (e) => {
                    e.stopPropagation();
                    void (async () => {
                        const ok = await planningConfirm(
                            'Supprimer cette période et tous les créneaux associés sur le planning ?',
                            { title: 'Supprimer la fermeture', confirmLabel: 'Supprimer', danger: true }
                        );
                        if (!ok) return;
                        void deleteClosureAt(index);
                    })();
                }
            })
        );
        grid.appendChild(actions);
    }

    card.appendChild(grid);
    return card;
}

function renderClosureCards() {
    const appliedHost = document.getElementById('fermetures-applied-cards');
    const pendingHost = document.getElementById('fermetures-pending-cards');
    const pendingSection = document.getElementById('fermetures-list-pending-section');
    if (!appliedHost || !pendingHost) return;

    appliedHost.replaceChildren();
    pendingHost.replaceChildren();
    const u = getPlanningSessionUser();

    const applied = [];
    const pending = [];
    closureRanges.forEach((r, index) => {
        if (fermeturesOwnOnlyFilter && !ownsClosureRange(r, u)) return;
        if (r.legacy || r.appliedAt) applied.push({ r, index });
        else pending.push({ r, index });
    });

    pendingSection?.classList.toggle('hidden', !pending.length);

    if (!applied.length && !pending.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-500 dark:text-slate-400 italic m-0 py-2';
        empty.textContent = canManageOwnClosures(u)
            ? 'Aucune période enregistrée pour l’année scolaire en cours.'
            : 'Aucune période sur l’année en cours.';
        appliedHost.appendChild(empty);
        syncFermeturesActionsRow();
        return;
    }

    for (const { r, index } of applied) {
        appliedHost.appendChild(buildClosureCard(r, index));
    }
    for (const { r, index } of pending) {
        pendingHost.appendChild(buildClosureCard(r, index));
    }
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
    document.getElementById('fermetures-main-panel')?.classList.remove('hidden');
    document.getElementById('fermetures-fab-wrap')?.classList.remove('hidden');

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
    panel.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    showToast(
        `${conflicts.length} créneau${conflicts.length > 1 ? 'x' : ''} en conflit : validez ou annulez ci-dessous.`,
        'warning',
        9000
    );
}

function showFermeturesMainPanel() {
    document.getElementById('fermetures-main-panel')?.classList.remove('hidden');
    document.getElementById('fermetures-fab-wrap')?.classList.remove('hidden');
    hideConflictPanel();
    renderClosureCards();
}

function openClosureEdit(index) {
    if (closureRanges[index]?._optimistic || closureApplyInFlight) return;
    void openFermetureEdit({
        index,
        source: 'menu',
        periodId: index >= 0 ? closureRanges[index]?.id : undefined
    });
}

async function collectConflictsForPendingApply() {
    const u = getPlanningSessionUser();
    const today = todayYmdLocal();
    const pending = pendingAbsencePeriodsForUser(closureRanges, u).filter(
        (p) => String(p.endYmd || '').slice(0, 10) >= today
    );
    /** @type {object[]} */
    const all = [];
    /** @type {Map<string, object[]>} */
    const byPeriod = new Map();
    for (const p of pending) {
        const conflicts = await findConflictsForClosurePeriod(p, []);
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
    const today = todayYmdLocal();
    const applicable = pending.filter((p) => String(p.endYmd || '').slice(0, 10) >= today);
    if (!applicable.length) {
        showToast(
            'Aucune période à publier : les brouillons entièrement passés restent en archive (sans impact sur le planning).',
            'info',
            9000
        );
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
            hideConflictPanel();
            showConflictPanel(all);
            window.__fermeturesApplyConflictMap = byPeriod;
            return;
        }
        hideConflictPanel();
        conflictsByPeriod = byPeriod;
    } else {
        conflictsByPeriod = window.__fermeturesApplyConflictMap || new Map();
        hideConflictPanel();
    }

    const r = await applyPendingAbsencePeriods(closureRanges, {
        deleteConflicts,
        conflictsByPeriodId: conflictsByPeriod,
        onProgress: (pct, label) => setApplyProgress(pct, label || 'Application…')
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
    if (window.__fermeturesApplyFromCalendar) {
        window.__fermeturesApplyFromCalendar = false;
        document.getElementById('modal_fermetures')?.close();
    }
}

function setConflictProceedBusy(busy) {
    const proceed = document.getElementById('fermetures-conflict-proceed');
    const cancel = document.getElementById('fermetures-conflict-cancel');
    if (proceed instanceof HTMLButtonElement) proceed.disabled = busy;
    if (cancel instanceof HTMLButtonElement) cancel.disabled = busy;
}

function returnToFermeturesList() {
    hideConflictPanel();
    showFermeturesMainPanel();
}

/** @param {object} range @param {number} index */
export async function deleteClosureAt(index) {
    const u = getPlanningSessionUser();
    const range = closureRanges[index];
    if (!range || !canDeleteClosureRange(range, u)) return;
    if (closureApplyInFlight) return;

    const { setClosureDeletionBusy, deleteClosureRangeEvents } = await import('./fermetures-planning.js');

    showToast('Suppression de la fermeture en cours…', 'info', 5000);
    setFermeturesModalBusy(true);
    setClosureDeletionBusy(true);
    setApplyProgress(0, 'Préparation de la suppression…');
    syncFermeturesActionsRow();
    renderClosureCards();

    const onProgress = (label, pct) => {
        setApplyProgress(pct, label);
        document.dispatchEvent(new CustomEvent('planning-calendar-chrome-refresh'));
    };

    try {
        if (range.legacy) {
            const r = await deleteClosureRangeEvents(range.eventIds, { onProgress });
            if (!r.ok) {
                showToast(r.error || 'Suppression impossible.', 'error');
                return;
            }
        } else if (range.appliedAt) {
            let eventIds = [...(range.eventIds || [])];
            if (!eventIds.length) {
                eventIds = await fetchEventIdsForAbsencePeriod(range.id);
            }
            if (eventIds.length) {
                const dr = await deleteClosureRangeEvents(eventIds, { onProgress });
                if (!dr.ok) {
                    showToast(dr.error || 'Suppression des fermetures impossible.', 'error');
                    return;
                }
            }
            setApplyProgress(95, 'Retrait de la période…');
            const r = await deleteAbsencePeriodOwned(range.id);
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
    } finally {
        setClosureDeletionBusy(false);
        setFermeturesModalBusy(false);
        setApplyProgress(100, 'Terminé');
        syncFermeturesActionsRow();
        renderClosureCards();
    }
}

/** Publie une période brouillon sur le planning. */
export async function applyOneClosurePeriod(period) {
    if (!period?.id || period.appliedAt) return { ok: false, error: 'Période déjà publiée.' };
    if (closureApplyInFlight) return { ok: false, error: 'Une application est déjà en cours.' };
    closureApplyInFlight = true;
    setFermeturesModalBusy(true);
    setApplyProgress(0, 'Publication sur le planning…');
    syncFermeturesActionsRow();
    try {
        const r = await applyPendingAbsencePeriods([period], {
            onProgress: (pct, label) => setApplyProgress(pct ?? 0, label || 'Publication…')
        });
        if (r.ok) await loadClosureRangesFromServer();
        return r;
    } finally {
        closureApplyInFlight = false;
        setFermeturesModalBusy(false);
        syncFermeturesActionsRow();
        renderClosureCards();
    }
}

export async function loadClosureRangesFromServer() {
    closureRanges = await loadAllAbsencePeriodsForUi();
}

/** Ouvre la modale fermetures sur une période (ex. depuis un créneau fermeture du planning). */
export function getClosureRangesRef() {
    return closureRanges;
}

export function returnToFermeturesListOnly() {
    returnToFermeturesList();
}

/** @param {object[]} conflicts @param {string} periodId @param {boolean} [fromCalendar] */
export async function showFermeturesConflictFromApply(conflicts, periodId, fromCalendar = false) {
    const u = getPlanningSessionUser();
    if (!canViewClosures(u)) return;
    const dlg = document.getElementById('modal_fermetures');
    if (dlg && !dlg.open) {
        if (fromCalendar) {
            await dlg.showModal();
        } else if (!openPlanningRouteFromDrawer('modal_fermetures', 'Fermetures / Indisponibilités', 'Menu')) {
            await dlg.showModal();
        }
    }
    await loadClosureRangesFromServer();
    showFermeturesMainPanel();
    const byPeriod = new Map();
    byPeriod.set(periodId, conflicts);
    window.__fermeturesApplyConflictMap = byPeriod;
    showConflictPanel(conflicts);
    window.__fermeturesApplyFromCalendar = fromCalendar;
}

export async function openClosureEditByPeriodId(periodId) {
    const id = String(periodId || '').trim();
    if (!id || id.startsWith('legacy:')) {
        showToast('Cette fermeture historique ne peut pas être modifiée ici.', 'info');
        return;
    }
    const u = getPlanningSessionUser();
    if (!canViewClosures(u)) {
        showToast('Indisponibilités : réservé aux professeurs et administrateurs.', 'info');
        return;
    }
    await fetchOrganSchoolSettings();
    await loadClosureRangesFromServer();
    const idx = closureRanges.findIndex((r) => r.id === id);
    if (idx < 0) {
        showToast('Période introuvable (rechargez la liste).', 'error');
        return;
    }
    void openFermetureEdit({ index: idx, periodId: id, source: 'menu' });
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
    pendingConflicts = [];
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

    document.getElementById('fermetures-filter-own')?.addEventListener('change', (ev) => {
        fermeturesOwnOnlyFilter = ev.target instanceof HTMLInputElement && ev.target.checked;
        renderClosureCards();
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
