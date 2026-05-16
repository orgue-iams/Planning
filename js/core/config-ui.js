/**
 * Modale Configuration (année scolaire + plage chapelle + règles élèves). Admin : écriture ; prof : lecture seule.
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import {
    fetchOrganSchoolSettings,
    getOrganSchoolSettingsCached,
    saveOrganSchoolSettingsAdmin
} from './organ-settings.js';
import { showToast } from '../utils/toast.js';
import { normalizeHHmmInput } from '../utils/time-helpers.js';
import { getPlanningSessionUser } from './session-user.js';
import { openPlanningRouteFromDrawer } from '../utils/planning-route-dialog.js';
import { syncPlanningDrawerGroupedSections } from './planning-drawer-ui.js';

let bound = false;
let configInitialSnapshot = '';
let persistTimer = 0;

const ELEVE_FIELD_IDS = [
    'config-eleve-cap-enabled',
    'config-eleve-cap-hours',
    'config-eleve-horizon-enabled',
    'config-eleve-horizon-amount',
    'config-eleve-no-delete-after-start'
];

const CONFIG_RULES = [
    { toggleId: 'config-eleve-cap-enabled', fieldId: 'config-eleve-cap-hours' },
    { toggleId: 'config-eleve-horizon-enabled', fieldId: 'config-eleve-horizon-amount' },
    { toggleId: 'config-eleve-no-delete-after-start', fieldId: null }
];

const CONFIG_PERSIST_IDS = [
    'config-school-start',
    'config-school-end',
    'config-chapel-min',
    'config-chapel-max',
    'config-planning-error-notify-email',
    ...ELEVE_FIELD_IDS
];

/** E-mail non vide : format simple type RFC minimal. */
function isValidNotifyEmail(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function ensureChapelHourSelectsFilled() {
    for (const id of ['config-chapel-min', 'config-chapel-max']) {
        const sel = document.getElementById(id);
        if (!(sel instanceof HTMLSelectElement)) continue;
        if (sel.dataset.planningChapelOpts === '1') continue;
        sel.replaceChildren();
        for (let h = 8; h <= 23; h++) {
            const v = `${String(h).padStart(2, '0')}:00`;
            const o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            sel.appendChild(o);
        }
        sel.dataset.planningChapelOpts = '1';
    }
}

/** Ramène une heure DB / saisie à une option HH:00 entre 08:00 et 23:00. */
function chapelHourToSelectValue(t) {
    const s = String(t || '').trim();
    const base = s.length >= 5 ? s.slice(0, 5) : '08:00';
    const n = normalizeHHmmInput(base.length === 5 ? base : '');
    const hh = parseInt((n || '08:00').slice(0, 2), 10);
    const clamped = Math.min(23, Math.max(8, Number.isFinite(hh) ? hh : 8));
    return `${String(clamped).padStart(2, '0')}:00`;
}

async function fillConfigModal() {
    ensureChapelHourSelectsFilled();
    await fetchOrganSchoolSettings();
    const data = getOrganSchoolSettingsCached();
    const s = document.getElementById('config-school-start');
    const e = document.getElementById('config-school-end');
    const mn = document.getElementById('config-chapel-min');
    const mx = document.getElementById('config-chapel-max');
    if (s) s.value = data?.school_year_start?.slice(0, 10) || '';
    if (e) e.value = data?.school_year_end?.slice(0, 10) || '';
    if (mn instanceof HTMLSelectElement) mn.value = chapelHourToSelectValue(data?.chapel_slot_min);
    if (mx instanceof HTMLSelectElement) mx.value = chapelHourToSelectValue(data?.chapel_slot_max);

    const em = document.getElementById('config-planning-error-notify-email');
    if (em) em.value = String(data?.planning_error_notify_email ?? '').trim();

    const capEn = document.getElementById('config-eleve-cap-enabled');
    if (capEn) capEn.checked = Boolean(data?.eleve_weekly_travail_cap_enabled);
    const capH = document.getElementById('config-eleve-cap-hours');
    if (capH) capH.value = String(data?.eleve_weekly_travail_cap_hours ?? '2');
    const hzEn = document.getElementById('config-eleve-horizon-enabled');
    if (hzEn) hzEn.checked = Boolean(data?.eleve_booking_horizon_enabled);
    const hzA = document.getElementById('config-eleve-horizon-amount');
    if (hzA) {
        const unit = data?.eleve_booking_horizon_unit === 'weeks' ? 'weeks' : 'days';
        const rawAmt = parseInt(String(data?.eleve_booking_horizon_amount ?? '0'), 10) || 0;
        const days =
            unit === 'weeks' ? rawAmt * 7 : rawAmt;
        hzA.value = String(days);
    }
    const noDel = document.getElementById('config-eleve-no-delete-after-start');
    if (noDel) noDel.checked = data?.eleve_forbid_delete_after_slot_start !== false;

    configInitialSnapshot = currentConfigSnapshot();
    syncConfigRuleRows();
}

function syncConfigRuleRows() {
    for (const rule of CONFIG_RULES) {
        const toggle = document.getElementById(rule.toggleId);
        const field = rule.fieldId ? document.getElementById(rule.fieldId) : null;
        const on = toggle instanceof HTMLInputElement && toggle.checked;
        if (field) field.classList.toggle('hidden', !on);
        if (toggle) {
            toggle.setAttribute('aria-checked', on ? 'true' : 'false');
            const lab = document.querySelector(`label.config-rule-toggle[for="${rule.toggleId}"]`);
            if (lab) lab.classList.toggle('config-rule-toggle--on', on);
        }
    }
}

function currentConfigSnapshot() {
    const base = {
        schoolStart: document.getElementById('config-school-start')?.value || '',
        schoolEnd: document.getElementById('config-school-end')?.value || '',
        chapelMin: document.getElementById('config-chapel-min')?.value || '',
        chapelMax: document.getElementById('config-chapel-max')?.value || '',
        notifyEmail: document.getElementById('config-planning-error-notify-email')?.value || ''
    };
    for (const id of ELEVE_FIELD_IDS) {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement && el.type === 'checkbox') base[id] = el.checked ? '1' : '0';
        else if (el) base[id] = el.value || '';
    }
    return JSON.stringify(base);
}

function minutesFromHHmm(hhmm) {
    const m = normalizeHHmmInput(String(hhmm || '').slice(0, 5));
    if (!m || m.length < 5) return null;
    const h = parseInt(m.slice(0, 2), 10);
    const min = parseInt(m.slice(3, 5), 10);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return h * 60 + min;
}

async function persistConfigIfAdmin() {
    const u = getPlanningSessionUser();
    if (!isAdmin(u)) return;

    const snap = currentConfigSnapshot();
    if (snap === configInitialSnapshot) return;

    const notifyRaw = document.getElementById('config-planning-error-notify-email')?.value ?? '';
    if (!isValidNotifyEmail(notifyRaw)) {
        showToast('E-mail d’alerte infrastructure : format invalide (ex. admin@exemple.fr).', 'error');
        return;
    }

    const mn = normalizeHHmmInput(document.getElementById('config-chapel-min')?.value);
    const mx = normalizeHHmmInput(document.getElementById('config-chapel-max')?.value);
    if (!mn || !mx) {
        showToast('Heures chapelle invalides.', 'error');
        return;
    }
    const minM = minutesFromHHmm(mn);
    const maxM = minutesFromHHmm(mx);
    if (minM == null || maxM == null || maxM <= minM) {
        showToast('La dernière heure affichée doit être après la première heure.', 'error');
        return;
    }

    const capOn = document.getElementById('config-eleve-cap-enabled')?.checked;
    const hzOn = document.getElementById('config-eleve-horizon-enabled')?.checked;
    const r = await saveOrganSchoolSettingsAdmin({
        school_year_start: document.getElementById('config-school-start')?.value || null,
        school_year_end: document.getElementById('config-school-end')?.value || null,
        chapel_slot_min: `${mn}:00`,
        chapel_slot_max: `${mx}:00`,
        planning_error_notify_email: notifyRaw,
        eleve_weekly_travail_cap_enabled: capOn,
        eleve_weekly_travail_cap_hours: document.getElementById('config-eleve-cap-hours')?.value,
        eleve_booking_horizon_enabled: hzOn,
        eleve_booking_horizon_amount: document.getElementById('config-eleve-horizon-amount')?.value,
        eleve_booking_horizon_unit: 'days',
        eleve_forbid_delete_after_slot_start: document.getElementById('config-eleve-no-delete-after-start')?.checked,
        eleve_booking_tolerance_days: 0
    });
    if (!r.ok) {
        showToast(r.error || 'Erreur.', 'error');
        return;
    }
    showToast('Configuration enregistrée.', 'success', 2800);
    configInitialSnapshot = currentConfigSnapshot();
    document.dispatchEvent(new CustomEvent('planning-organ-settings-updated'));
}

function scheduleConfigPersist() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => void persistConfigIfAdmin(), 550);
}

export function initConfigUi(currentUser) {
    const show = isBackendAuthConfigured() && (currentUser?.role === 'admin' || currentUser?.role === 'prof');
    document.getElementById('menu-item-config-wrap')?.classList.toggle('hidden', !show);
    syncPlanningDrawerGroupedSections();
    if (!show || bound) return;
    bound = true;

    ensureChapelHourSelectsFilled();

    const admin = isAdmin(currentUser);
    document.getElementById('config-hint-admin')?.classList.toggle('hidden', !admin);
    document.getElementById('config-hint-readonly')?.classList.toggle('hidden', admin);
    document.getElementById('config-planning-notify-wrap')?.classList.toggle('hidden', !admin);

    for (const id of ['config-school-start', 'config-school-end', 'config-chapel-min', 'config-chapel-max']) {
        const el = document.getElementById(id);
        el?.toggleAttribute('disabled', !admin);
        el?.classList.toggle('bg-slate-200', !admin);
        el?.classList.toggle('text-slate-500', !admin);
        el?.classList.toggle('cursor-not-allowed', !admin);
    }
    const notifyEl = document.getElementById('config-planning-error-notify-email');
    notifyEl?.toggleAttribute('disabled', !admin);
    notifyEl?.classList.toggle('bg-slate-200', !admin);
    notifyEl?.classList.toggle('text-slate-500', !admin);
    notifyEl?.classList.toggle('cursor-not-allowed', !admin);

    for (const id of ELEVE_FIELD_IDS) {
        const el = document.getElementById(id);
        el?.toggleAttribute('disabled', !admin);
        el?.classList.toggle('bg-slate-200', !admin && !(el instanceof HTMLInputElement && el.type === 'checkbox'));
        el?.classList.toggle('text-slate-500', !admin);
        el?.classList.toggle('cursor-not-allowed', !admin);
    }

    document.getElementById('menu-item-config')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (!openPlanningRouteFromDrawer('modal_config', 'Configuration du planning', 'Configuration')) {
            return;
        }
        void fillConfigModal();
    });

    /* Un seul événement par champ : `input` + `change` déclenchaient plusieurs sauvegardes (ex. nombre de toasts). */
    for (const id of CONFIG_PERSIST_IDS) {
        const el = document.getElementById(id);
        el?.addEventListener('change', () => {
            syncConfigRuleRows();
            scheduleConfigPersist();
        });
    }
    for (const rule of CONFIG_RULES) {
        const toggle = document.getElementById(rule.toggleId);
        toggle?.addEventListener('change', () => {
            syncConfigRuleRows();
            scheduleConfigPersist();
        });
    }
}

export function resetConfigUiBindings() {
    bound = false;
}
