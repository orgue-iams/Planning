/**
 * Modale Configuration (année scolaire + plage chapelle + règles élèves). Admin : écriture ; prof : lecture seule.
 */
import { isAdmin } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import {
    fetchOrganSchoolSettings,
    getOrganSchoolSettingsCached,
    saveOrganSchoolSettingsAdmin,
    invalidateOrganSchoolSettingsCache
} from './organ-settings.js';
import { showToast } from '../utils/toast.js';
import { normalizeHHmmInput } from '../utils/time-helpers.js';

let bound = false;
let configInitialSnapshot = '';

const ELEVE_FIELD_IDS = [
    'config-eleve-cap-enabled',
    'config-eleve-cap-hours',
    'config-eleve-horizon-enabled',
    'config-eleve-horizon-amount',
    'config-eleve-horizon-unit',
    'config-eleve-void-toward-cap',
    'config-eleve-no-delete-after-start',
    'config-eleve-tolerance-days'
];

function timeDbToInput(t) {
    if (!t) return '08:00';
    const s = String(t).slice(0, 5);
    const n = normalizeHHmmInput(s.length === 5 ? s : '');
    return n || '08:00';
}

async function fillConfigModal() {
    await fetchOrganSchoolSettings();
    const data = getOrganSchoolSettingsCached();
    const s = document.getElementById('config-school-start');
    const e = document.getElementById('config-school-end');
    const mn = document.getElementById('config-chapel-min');
    const mx = document.getElementById('config-chapel-max');
    if (s) s.value = data?.school_year_start?.slice(0, 10) || '';
    if (e) e.value = data?.school_year_end?.slice(0, 10) || '';
    if (mn) mn.value = timeDbToInput(data?.chapel_slot_min);
    if (mx) mx.value = timeDbToInput(data?.chapel_slot_max);
    const em = document.getElementById('config-planning-error-notify-email');
    if (em) em.value = String(data?.planning_error_notify_email ?? '').trim();

    const capEn = document.getElementById('config-eleve-cap-enabled');
    if (capEn) capEn.checked = Boolean(data?.eleve_weekly_travail_cap_enabled);
    const capH = document.getElementById('config-eleve-cap-hours');
    if (capH) capH.value = String(data?.eleve_weekly_travail_cap_hours ?? '2');
    const hzEn = document.getElementById('config-eleve-horizon-enabled');
    if (hzEn) hzEn.checked = Boolean(data?.eleve_booking_horizon_enabled);
    const hzA = document.getElementById('config-eleve-horizon-amount');
    if (hzA) hzA.value = String(data?.eleve_booking_horizon_amount ?? '14');
    const hzU = document.getElementById('config-eleve-horizon-unit');
    if (hzU) hzU.value = data?.eleve_booking_horizon_unit === 'weeks' ? 'weeks' : 'days';
    const vTow = document.getElementById('config-eleve-void-toward-cap');
    if (vTow) vTow.checked = data?.eleve_count_voided_travail_toward_cap !== false;
    const noDel = document.getElementById('config-eleve-no-delete-after-start');
    if (noDel) noDel.checked = data?.eleve_forbid_delete_after_slot_start !== false;
    const tol = document.getElementById('config-eleve-tolerance-days');
    if (tol) tol.value = String(data?.eleve_booking_tolerance_days ?? '0');

    configInitialSnapshot = currentConfigSnapshot();
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

function isConfigDirty() {
    return currentConfigSnapshot() !== configInitialSnapshot;
}

export function initConfigUi(currentUser) {
    const show = isBackendAuthConfigured() && (currentUser?.role === 'admin' || currentUser?.role === 'prof');
    document.getElementById('menu-item-config-wrap')?.classList.toggle('hidden', !show);
    if (!show || bound) return;
    bound = true;

    const admin = isAdmin(currentUser);
    document.getElementById('config-hint-admin')?.classList.toggle('hidden', !admin);
    document.getElementById('config-hint-readonly')?.classList.toggle('hidden', admin);
    document.getElementById('config-save-btn')?.classList.toggle('hidden', !admin);
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
        document.getElementById('btn-header-settings')?.blur();
        void fillConfigModal().then(() => document.getElementById('modal_config')?.showModal());
    });

    document.getElementById('config-close-btn')?.addEventListener('click', () => {
        if (admin && isConfigDirty()) {
            const ok = confirm('Fermer sans enregistrer vos modifications ?');
            if (!ok) return;
        }
        document.getElementById('modal_config')?.close();
    });

    document.getElementById('config-save-btn')?.addEventListener('click', async () => {
        if (!admin) return;
        const mn = normalizeHHmmInput(document.getElementById('config-chapel-min')?.value);
        const mx = normalizeHHmmInput(document.getElementById('config-chapel-max')?.value);
        if (!mn || !mx) {
            showToast('Heures chapelle invalides : format 24 h (ex. 08:00, 22:00).', 'error');
            return;
        }
        const capOn = document.getElementById('config-eleve-cap-enabled')?.checked;
        const hzOn = document.getElementById('config-eleve-horizon-enabled')?.checked;
        const r = await saveOrganSchoolSettingsAdmin({
            school_year_start: document.getElementById('config-school-start')?.value || null,
            school_year_end: document.getElementById('config-school-end')?.value || null,
            chapel_slot_min: `${mn}:00`,
            chapel_slot_max: `${mx}:00`,
            planning_error_notify_email: document.getElementById('config-planning-error-notify-email')?.value ?? '',
            eleve_weekly_travail_cap_enabled: capOn,
            eleve_weekly_travail_cap_hours: document.getElementById('config-eleve-cap-hours')?.value,
            eleve_booking_horizon_enabled: hzOn,
            eleve_booking_horizon_amount: document.getElementById('config-eleve-horizon-amount')?.value,
            eleve_booking_horizon_unit: document.getElementById('config-eleve-horizon-unit')?.value,
            eleve_count_voided_travail_toward_cap: document.getElementById('config-eleve-void-toward-cap')?.checked,
            eleve_forbid_delete_after_slot_start: document.getElementById('config-eleve-no-delete-after-start')
                ?.checked,
            eleve_booking_tolerance_days: document.getElementById('config-eleve-tolerance-days')?.value
        });
        if (!r.ok) {
            showToast(r.error || 'Erreur.', 'error');
            return;
        }
        invalidateOrganSchoolSettingsCache();
        showToast('Configuration enregistrée. Rechargez la page pour mettre à jour la grille si besoin.', 'success');
        configInitialSnapshot = currentConfigSnapshot();
        document.getElementById('modal_config')?.close();
    });
}

export function resetConfigUiBindings() {
    bound = false;
}
