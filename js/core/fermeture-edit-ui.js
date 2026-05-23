/**
 * Édition fermeture (modale type réservation) : depuis menu fermetures ou clic planning.
 */
import { isAdmin, isProf } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';
import {
    resetPlanningRouteStack,
    planningRouteTitle,
    setPlanningRouteBarHidden
} from '../utils/planning-route-dialog.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';
import { getChapelSlotBounds, fetchOrganSchoolSettings, getSchoolYearBoundsFromSettings } from './organ-settings.js';
import {
    CLOSURE_WEEKDAY_OPTIONS,
    buildHalfHourTimeChoices,
    fillTimeSelect,
    normalizeClosureTime,
    normalizeDayOverrides,
    normalizeWeekdays
} from '../utils/closure-period-helpers.js';
import {
    deleteAbsencePeriodDraft,
    deleteAbsencePeriodOwned,
    fetchEventIdsForAbsencePeriod,
    saveAbsencePeriodDraft
} from './absence-period-db.js';
import {
    deleteClosureRangeEvents,
    findConflictsForClosurePeriod,
    saveClosureRangeToPlanning
} from './fermetures-planning.js';
import { createPlanningIconDeleteButton } from '../utils/planning-delete-btn.js';
import { invalidateCalendarListCache } from './calendar-events-list-cache.js';
import { planningConfirm } from '../utils/planning-confirm.js';
import { canEditClosureRange, canDeleteClosureRange, canManageOwnClosures, canViewClosures } from './fermetures-ui.js';

let bound = false;
/** @type {{ source: 'menu'|'calendar', periodIndex: number, clickedYmd: string, activeTab: 'period'|'day' } | null} */
let editCtx = null;

function todayYmdLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fermeturesUiModule() {
    return import('./fermetures-ui.js');
}

function getPeriodRef() {
    return editCtx?.period ?? null;
}

function fillWeekdayCheckboxes() {
    const host = document.getElementById('fermeture-edit-weekdays');
    if (!host || host.dataset.bound === '1') return;
    host.replaceChildren();
    for (const o of CLOSURE_WEEKDAY_OPTIONS) {
        const lab = document.createElement('label');
        lab.className =
            'inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-800 cursor-pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'checkbox checkbox-xs';
        cb.value = String(o.iso);
        cb.dataset.weekdayIso = String(o.iso);
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(o.label));
        host.appendChild(lab);
    }
    host.dataset.bound = '1';
}

function readWeekdaysFromForm() {
    const host = document.getElementById('fermeture-edit-weekdays');
    if (!host) return [];
    const out = [];
    host.querySelectorAll('input[type=checkbox]:checked').forEach((el) => {
        if (el instanceof HTMLInputElement) out.push(parseInt(el.value, 10));
    });
    return normalizeWeekdays(out);
}

function applyWeekdaysToForm(weekdays) {
    const set = new Set(normalizeWeekdays(weekdays));
    document.getElementById('fermeture-edit-weekdays')?.querySelectorAll('input[type=checkbox]').forEach((el) => {
        if (el instanceof HTMLInputElement) {
            el.checked = set.has(parseInt(el.value, 10));
        }
    });
}

function syncTimeSelects() {
    const { slotMinTime, slotMaxTime } = getChapelSlotBounds();
    const choices = buildHalfHourTimeChoices(slotMinTime, slotMaxTime);
    fillTimeSelect(document.getElementById('fermeture-edit-time-start'), choices, '08:00');
    fillTimeSelect(document.getElementById('fermeture-edit-time-end'), choices, '18:00');
    fillTimeSelect(document.getElementById('fermeture-edit-single-time-start'), choices, '08:00');
    fillTimeSelect(document.getElementById('fermeture-edit-single-time-end'), choices, '18:00');
}

function syncPeriodicUi() {
    const periodic = document.getElementById('fermeture-edit-periodic')?.checked;
    document.getElementById('fermeture-edit-weekdays-wrap')?.classList.toggle('hidden', !periodic);
    document.getElementById('fermeture-edit-dates-wrap')?.classList.toggle('hidden', periodic);
}

function schoolYearBoundsForPeriodic() {
    const { startYmd: sy, endYmd: ey } = getSchoolYearBoundsFromSettings();
    const today = todayYmdLocal();
    let start = sy || today;
    if (start < today) start = today;
    const end = ey || today;
    return { startYmd: start, endYmd: end >= start ? end : start };
}

function readPeriodForm() {
    const periodic = Boolean(document.getElementById('fermeture-edit-periodic')?.checked);
    const bounds = periodic ? schoolYearBoundsForPeriodic() : {};
    return {
        startYmd:
            periodic
                ? bounds.startYmd
                : String(document.getElementById('fermeture-edit-start')?.value || '').trim(),
        endYmd:
            periodic
                ? bounds.endYmd
                : String(document.getElementById('fermeture-edit-end')?.value || '').trim(),
        title: String(document.getElementById('fermeture-edit-title')?.value || '').trim(),
        isPeriodic: periodic,
        weekdays: periodic ? readWeekdaysFromForm() : [],
        slotStartTime: normalizeClosureTime(
            document.getElementById('fermeture-edit-time-start')?.value
        ),
        slotEndTime: normalizeClosureTime(document.getElementById('fermeture-edit-time-end')?.value)
    };
}

function applyPeriodToForm(range) {
    const periodic = Boolean(range?.isPeriodic);
    const cb = document.getElementById('fermeture-edit-periodic');
    if (cb instanceof HTMLInputElement) cb.checked = periodic;
    const s = document.getElementById('fermeture-edit-start');
    const e = document.getElementById('fermeture-edit-end');
    const t = document.getElementById('fermeture-edit-title');
    if (s instanceof HTMLInputElement) s.value = range?.startYmd || todayYmdLocal();
    if (e instanceof HTMLInputElement) e.value = range?.endYmd || range?.startYmd || todayYmdLocal();
    if (t instanceof HTMLInputElement) t.value = range?.title || '';
    applyWeekdaysToForm(range?.weekdays || []);
    syncTimeSelects();
    const st = range?.slotStartTime || '08:00';
    const en = range?.slotEndTime || '18:00';
    const ts = document.getElementById('fermeture-edit-time-start');
    const te = document.getElementById('fermeture-edit-time-end');
    if (ts instanceof HTMLSelectElement) ts.value = st;
    if (te instanceof HTMLSelectElement) te.value = en;
    syncPeriodicUi();
}

function setReadonly(readonly, period) {
    const u = getPlanningSessionUser();
    const ids = [
        'fermeture-edit-start',
        'fermeture-edit-end',
        'fermeture-edit-title',
        'fermeture-edit-periodic',
        'fermeture-edit-time-start',
        'fermeture-edit-time-end',
        'fermeture-edit-single-ymd',
        'fermeture-edit-single-title',
        'fermeture-edit-single-time-start',
        'fermeture-edit-single-time-end'
    ];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
            el.disabled = readonly;
        }
    }
    document.getElementById('fermeture-edit-weekdays')?.querySelectorAll('input').forEach((el) => {
        if (el instanceof HTMLInputElement) el.disabled = readonly;
    });
    document.getElementById('fermeture-edit-save')?.classList.toggle('hidden', readonly);
    const canDel = period && canDeleteClosureRange(period, u);
    const onDayTab = editCtx?.activeTab === 'day';
    document.getElementById('fermeture-edit-delete')?.classList.toggle(
        'hidden',
        readonly || !canDel || (onDayTab && !period?.isPeriodic)
    );
    syncDayTabActions(readonly);
}

function syncPeriodHeading(range) {
    const el = document.getElementById('fermeture-edit-period-heading');
    if (!el) return;
    const hide = editCtx?.activeTab === 'day';
    const title = String(range?.title || '').trim() || 'Fermeture';
    el.textContent = title;
    el.classList.toggle('hidden', hide || !range);
}

function syncTabsUi() {
    const period = getPeriodRef();
    const showTabs = Boolean(
        editCtx?.source === 'calendar' && period?.isPeriodic && period?.appliedAt && editCtx.clickedYmd
    );
    const tabs = document.getElementById('fermeture-edit-tabs');
    tabs?.classList.toggle('hidden', !showTabs);
    const isDay = showTabs && editCtx?.activeTab === 'day';
    document.getElementById('fermeture-edit-panel-period')?.classList.toggle('hidden', isDay);
    document.getElementById('fermeture-edit-panel-day')?.classList.toggle('hidden', !isDay);
    const tabPeriod = document.getElementById('fermeture-edit-tab-period');
    const tabDay = document.getElementById('fermeture-edit-tab-day');
    tabPeriod?.classList.toggle('fermeture-edit-tabs__btn--active', !isDay);
    tabDay?.classList.toggle('fermeture-edit-tabs__btn--active', isDay);
    tabPeriod?.setAttribute('aria-selected', isDay ? 'false' : 'true');
    tabDay?.setAttribute('aria-selected', isDay ? 'true' : 'false');
    syncPeriodHeading(period);
    if (isDay && editCtx?.clickedYmd) {
        const ymd = editCtx.clickedYmd;
        const period = getPeriodRef();
        const sy = document.getElementById('fermeture-edit-single-ymd');
        if (sy instanceof HTMLInputElement) {
            sy.value = ymd;
            sy.readOnly = true;
        }
        const overrides = normalizeDayOverrides(period?.dayOverrides);
        const ov = overrides.find((o) => o.ymd === ymd);
        const ts = document.getElementById('fermeture-edit-single-time-start');
        const te = document.getElementById('fermeture-edit-single-time-end');
        const tt = document.getElementById('fermeture-edit-single-title');
        const st = ov?.slot_start_time || period?.slotStartTime || '08:00';
        const en = ov?.slot_end_time || period?.slotEndTime || '18:00';
        if (ts instanceof HTMLSelectElement) ts.value = st;
        if (te instanceof HTMLSelectElement) te.value = en;
        if (tt instanceof HTMLInputElement) {
            tt.value = String(ov?.title || period?.title || '').trim();
        }
    }
    syncDayTabActions();
}

function syncDayTabActions(readonly = false) {
    const isDay = editCtx?.activeTab === 'day';
    const del = document.getElementById('fermeture-edit-delete');
    const save = document.getElementById('fermeture-edit-save');
    if (save instanceof HTMLButtonElement) {
        save.textContent = isDay ? 'Enregistrer ce jour' : 'Enregistrer';
    }
    if (del instanceof HTMLButtonElement) {
        del.textContent = isDay ? 'Supprimer ce jour' : 'Supprimer';
    }
    void readonly;
}

function resolveFermetureEditDialogTitle(index, range, editable, fromCalendar) {
    if (index < 0) return 'Nouvelle fermeture';
    if (range?.isPeriodic && !fromCalendar) return 'Fermeture périodique';
    if (!editable) return 'Fermeture';
    return 'Modifier la fermeture';
}

function syncFermetureEditDialogTitle(index, range, editable, fromCalendar) {
    const title = resolveFermetureEditDialogTitle(index, range, editable, fromCalendar);
    const heading = document.getElementById('fermeture-edit-dialog-title');
    if (heading) {
        heading.textContent = title;
        heading.classList.toggle('hidden', fromCalendar);
    }
    const dlg = document.getElementById('modal_fermeture_edit');
    if (dlg instanceof HTMLDialogElement && !fromCalendar) {
        dlg.setAttribute('aria-label', title);
    }
}

function closeFermetureEditModal() {
    const dlg = document.getElementById('modal_fermeture_edit');
    if (dlg?.open) {
        dlg.classList.remove('planning-route-page');
        dlg.close();
    }
    editCtx = null;
}

async function deleteCurrentPeriod() {
    const u = getPlanningSessionUser();
    const period = getPeriodRef();
    if (!period || !canDeleteClosureRange(period, u)) return;

    if (editCtx?.activeTab === 'day' && period.isPeriodic && editCtx.clickedYmd) {
        const ok = await planningConfirm(
            'Retirer uniquement ce jour de la fermeture périodique sur le planning ?',
            { title: 'Supprimer ce jour', confirmLabel: 'Supprimer', danger: true }
        );
        if (!ok) return;
        showToast('Mise à jour de la fermeture…', 'info', 4000);
        await excludeSinglePeriodicDay(editCtx.clickedYmd);
        return;
    }

    const ok = await planningConfirm(
        'Supprimer toute la période et tous les créneaux associés sur le planning ?',
        { title: 'Supprimer la fermeture', confirmLabel: 'Supprimer', danger: true }
    );
    if (!ok) return;

    const idx = editCtx?.periodIndex;
    const source = editCtx?.source;
    closeFermetureEditModal();
    const mod = await fermeturesUiModule();
    if (typeof idx === 'number' && idx >= 0) {
        await mod.deleteClosureAt(idx);
    }
    if (source === 'menu') await mod.loadClosureRangesFromServer();
}

async function excludeSinglePeriodicDay(ymd) {
    const period = getPeriodRef();
    if (!period?.id || !ymd) return;
    const excluded = [...new Set([...(period.excludedYmds || []), ymd])];
    let eventIds = [...(period.eventIds || [])];
    if (!eventIds.length) eventIds = await fetchEventIdsForAbsencePeriod(period.id);
    const r = await saveAbsencePeriodDraft({
        id: period.id,
        startYmd: period.startYmd,
        endYmd: period.endYmd,
        title: period.title,
        isPeriodic: true,
        weekdays: period.weekdays,
        slotStartTime: period.slotStartTime,
        slotEndTime: period.slotEndTime,
        excludedYmds: excluded,
        dayOverrides: period.dayOverrides,
        allowAppliedUpdate: true
    });
    if (!r.ok || !r.period) {
        showToast(r.error || 'Mise à jour impossible.', 'error');
        return;
    }
    const updated = r.period;
    let eventIds = [...(period.eventIds || [])];
    if (!eventIds.length) eventIds = await fetchEventIdsForAbsencePeriod(updated.id);
    const del = await saveClosureRangeToPlanning(
        {
            ...updated,
            excludedYmds: excluded,
            absencePeriodId: updated.id,
            eventIds
        },
        {}
    );
    if (!del.ok) {
        showToast(del.error || 'Suppression du jour impossible.', 'error');
        return;
    }
    showToast('Jour retiré de la fermeture périodique.', 'success');
    invalidateCalendarListCache();
    document.dispatchEvent(new CustomEvent('planning-events-changed'));
    const mod = await fermeturesUiModule();
    await mod.loadClosureRangesFromServer();
    closeFermetureEditModal();
}

async function persistSingleDayOverride() {
    const period = getPeriodRef();
    const ymd = String(editCtx?.clickedYmd || '').slice(0, 10);
    if (!period?.id || !ymd || !period.isPeriodic) return;

    const slotStartTime = normalizeClosureTime(
        document.getElementById('fermeture-edit-single-time-start')?.value
    );
    const slotEndTime = normalizeClosureTime(
        document.getElementById('fermeture-edit-single-time-end')?.value
    );
    const title = String(document.getElementById('fermeture-edit-single-title')?.value || '').trim();
    if (!slotStartTime || !slotEndTime || slotEndTime <= slotStartTime) {
        showToast('Indiquez des horaires valides.', 'error');
        return;
    }

    const overrides = normalizeDayOverrides(period.dayOverrides).filter((o) => o.ymd !== ymd);
    overrides.push({
        ymd,
        slot_start_time: slotStartTime,
        slot_end_time: slotEndTime,
        title: title || undefined
    });

    const draft = await saveAbsencePeriodDraft({
        id: period.id,
        startYmd: period.startYmd,
        endYmd: period.endYmd,
        title: period.title,
        isPeriodic: true,
        weekdays: period.weekdays,
        slotStartTime: period.slotStartTime,
        slotEndTime: period.slotEndTime,
        excludedYmds: period.excludedYmds,
        dayOverrides: overrides,
        allowAppliedUpdate: true
    });
    if (!draft.ok || !draft.period) {
        showToast(draft.error || 'Mise à jour impossible.', 'error');
        return;
    }

    let eventIds = [...(period.eventIds || [])];
    if (!eventIds.length) eventIds = await fetchEventIdsForAbsencePeriod(draft.period.id);
    const payload = {
        ...draft.period,
        eventIds,
        absencePeriodId: draft.period.id
    };
    const conflicts = await findConflictsForClosurePeriod(payload, period.eventIds || []);
    if (conflicts.length) {
        const fromCalendar = editCtx?.source === 'calendar';
        closeFermetureEditModal();
        const mod = await fermeturesUiModule();
        await mod.showFermeturesConflictFromApply(conflicts, draft.period.id, fromCalendar);
        return;
    }
    const apply = await saveClosureRangeToPlanning(payload, { deleteConflicts: false });
    if (!apply.ok) {
        showToast(apply.error || 'Application impossible.', 'error');
        return;
    }
    showToast('Jour de fermeture mis à jour.', 'success');
    invalidateCalendarListCache();
    document.dispatchEvent(new CustomEvent('planning-events-changed'));
    closeFermetureEditModal();
}

async function persistEdit() {
    if (!canManageOwnClosures(getPlanningSessionUser())) return;
    const period = getPeriodRef();

    if (editCtx?.activeTab === 'day' && period?.isPeriodic && editCtx.clickedYmd) {
        await persistSingleDayOverride();
        return;
    }

    const f = readPeriodForm();
    if (!f.startYmd || !f.endYmd) {
        showToast('Indiquez les dates.', 'error');
        return;
    }
    if (f.endYmd < f.startYmd) {
        showToast('La date de fin doit être après le début.', 'error');
        return;
    }
    if (f.isPeriodic && !f.weekdays.length) {
        showToast('Cochez au moins un jour de la semaine.', 'error');
        return;
    }

    const draft = await saveAbsencePeriodDraft({
        id: period?.legacy ? undefined : period?.id,
        ...f,
        excludedYmds: period?.excludedYmds,
        dayOverrides: period?.dayOverrides,
        allowAppliedUpdate: Boolean(period?.appliedAt)
    });
    if (!draft.ok || !draft.period) {
        showToast(draft.error || 'Enregistrement impossible.', 'error');
        return;
    }

    if (period?.appliedAt) {
        const payload = {
            ...draft.period,
            eventIds: period.eventIds,
            absencePeriodId: draft.period.id
        };
        const conflicts = await findConflictsForClosurePeriod(payload, period.eventIds || []);
        if (conflicts.length) {
            const fromCalendar = editCtx?.source === 'calendar';
            closeFermetureEditModal();
            const mod = await fermeturesUiModule();
            await mod.showFermeturesConflictFromApply(conflicts, draft.period.id, fromCalendar);
            return;
        }
        const apply = await saveClosureRangeToPlanning(payload, { deleteConflicts: false });
        if (!apply.ok) {
            showToast(apply.error || 'Application impossible.', 'error');
            return;
        }
        invalidateCalendarListCache();
        document.dispatchEvent(new CustomEvent('planning-events-changed'));
        showToast('Fermeture mise à jour.', 'success');
        closeFermetureEditModal();
        return;
    }

    const mod = await fermeturesUiModule();
    await mod.loadClosureRangesFromServer();

    showToast(
        f.isPeriodic
            ? 'Fermeture périodique enregistrée. Utilisez « Appliquer les absences » pour la publier sur le planning.'
            : 'Période enregistrée. Utilisez « Appliquer les absences » pour la publier sur le planning.',
        'success',
        f.isPeriodic ? 8000 : 6000
    );

    const source = editCtx?.source;
    closeFermetureEditModal();
    if (source === 'menu') mod.returnToFermeturesListOnly();
}

/**
 * @param {object} [opts]
 * @param {number} [opts.index] index dans closureRanges (-1 = nouveau)
 * @param {string} [opts.periodId]
 * @param {string} [opts.clickedYmd]
 * @param {'menu'|'calendar'} [opts.source]
 */
export async function openFermetureEdit(opts = {}) {
    const u = getPlanningSessionUser();
    if (!canViewClosures(u)) {
        showToast('Indisponibilités : réservé aux professeurs et administrateurs.', 'info');
        return;
    }
    await fetchOrganSchoolSettings();
    const mod = await fermeturesUiModule();
    await mod.loadClosureRangesFromServer();
    const ranges = mod.getClosureRangesRef();

    let index = typeof opts.index === 'number' ? opts.index : -1;
    const pid = String(opts.periodId || '').trim();
    if (pid && index < 0) index = ranges.findIndex((r) => r.id === pid);

    const range =
        index >= 0
            ? ranges[index]
            : {
                  startYmd: todayYmdLocal(),
                  endYmd: todayYmdLocal(),
                  title: '',
                  slotStartTime: '08:00',
                  slotEndTime: '18:00'
              };

    const editable = index < 0 ? canManageOwnClosures(u) : canEditClosureRange(range, u);
    const dlg = document.getElementById('modal_fermeture_edit');
    if (!(dlg instanceof HTMLDialogElement)) return;

    const fromCalendar = opts.source === 'calendar';
    const periodSnapshot = index >= 0 ? { ...ranges[index] } : null;
    editCtx = {
        source: fromCalendar ? 'calendar' : 'menu',
        periodIndex: index,
        period: periodSnapshot,
        clickedYmd: String(opts.clickedYmd || '').slice(0, 10),
        activeTab: 'period'
    };

    fillWeekdayCheckboxes();
    syncTimeSelects();
    applyPeriodToForm(range);
    setReadonly(!editable, periodSnapshot);
    syncTabsUi();
    syncFermetureEditDialogTitle(index, range, editable, fromCalendar);

    const backLabel = fromCalendar ? 'Planning' : 'Fermetures / Indisponibilités';
    const routeTitle = planningRouteTitle(
        resolveFermetureEditDialogTitle(index, range, editable, fromCalendar)
    );

    if (fromCalendar) {
        dlg.classList.add('planning-route-page');
        resetPlanningRouteStack('modal_fermeture_edit', routeTitle, backLabel);
        setPlanningRouteBarHidden('modal_fermetures', false);
    } else {
        dlg.classList.remove('planning-route-page');
        if (document.getElementById('modal_fermetures')?.open) {
            setPlanningRouteBarHidden('modal_fermetures', true);
        }
    }
    if (!dlg.open) dlg.showModal();
    focusPlanningDialogRoot(dlg);
}

/** @param {object} fcEvent */
export async function openFermetureEditFromCalendarEvent(fcEvent) {
    const xp = fcEvent?.extendedProps || {};
    const periodId = String(xp.planningAbsencePeriodId || xp.absence_period_id || '').trim();
    let ymd = '';
    if (fcEvent?.start) {
        const d = fcEvent.start instanceof Date ? fcEvent.start : new Date(fcEvent.start);
        if (!Number.isNaN(d.getTime())) {
            ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
    }
    if (!periodId) {
        showToast('Fermeture sans période liée : ouvrez le menu Fermetures.', 'info');
        return;
    }
    await openFermetureEdit({ periodId, clickedYmd: ymd, source: 'calendar' });
}

export function initFermetureEditUi() {
    if (bound) return;
    bound = true;
    fillWeekdayCheckboxes();

    document.getElementById('fermeture-edit-periodic')?.addEventListener('change', syncPeriodicUi);

    document.getElementById('fermeture-edit-tab-period')?.addEventListener('click', () => {
        if (!editCtx) return;
        editCtx.activeTab = 'period';
        syncTabsUi();
    });
    document.getElementById('fermeture-edit-tab-day')?.addEventListener('click', () => {
        if (!editCtx) return;
        editCtx.activeTab = 'day';
        syncTabsUi();
    });

    document.getElementById('fermeture-edit-cancel')?.addEventListener('click', () => {
        closeFermetureEditModal();
    });

    document.getElementById('fermeture-edit-save')?.addEventListener('click', () => void persistEdit());
    document.getElementById('fermeture-edit-delete')?.addEventListener('click', () => void deleteCurrentPeriod());

    document.getElementById('modal_fermeture_edit')?.addEventListener('close', () => {
        editCtx = null;
        document.getElementById('modal_fermeture_edit')?.classList.remove('planning-route-page');
        const ferm = document.getElementById('modal_fermetures');
        if (ferm?.open) setPlanningRouteBarHidden('modal_fermetures', false);
    });
}

export function resetFermetureEditUiBindings() {
    bound = false;
    editCtx = null;
}
