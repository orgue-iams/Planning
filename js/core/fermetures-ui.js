/**
 * Périodes de fermetures (organ_school_settings.template_apply_closure_ranges).
 */
import { isAdmin, isProf } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import {
    fetchOrganSchoolSettings,
    getOrganSchoolSettingsCached,
    saveTemplateClosureRanges
} from './organ-settings.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';
import {
    openPlanningRouteFromDrawer,
    setPlanningRouteBackHandler,
    updatePlanningRouteDialog
} from '../utils/planning-route-dialog.js';
import { mountPlanningSwipeCard } from '../utils/planning-card-swipe.js';

let bound = false;

/** @type {{ startYmd: string, endYmd: string, title?: string }[]} */
let closureRanges = [];

/** @type {number | null} */
let editingClosureIndex = null;

let saveDebounce = null;

function canEditClosures(user) {
    return isAdmin(user) || isProf(user);
}

/** @param {unknown} raw */
export function parseClosureRangesFromSettings(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const startYmd = String(item.startYmd || item.start || '').trim();
        const endYmd = String(item.endYmd || item.end || '').trim();
        const title = String(item.title || '').trim();
        if (startYmd && endYmd && endYmd >= startYmd) {
            out.push({ startYmd, endYmd, ...(title ? { title } : {}) });
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
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    if (startYmd === endYmd) return s.toLocaleDateString('fr-FR', opts);
    return `${s.toLocaleDateString('fr-FR', opts)} → ${e.toLocaleDateString('fr-FR', opts)}`;
}

function buildClosureCard(range, index, editable) {
    const card = document.createElement('div');
    card.className =
        'fermeture-card rounded-xl border border-orange-200/80 bg-orange-50/95 dark:border-orange-700/50 dark:bg-orange-950/45 px-3 py-2.5 min-w-0';
    card.dataset.closureIndex = String(index);

    const body = document.createElement('div');
    body.className = 'flex-1 min-w-0';
    const dates = document.createElement('p');
    dates.className = 'text-[12px] font-mono font-semibold text-slate-800 dark:text-orange-50 m-0 leading-snug';
    dates.textContent = formatFrRange(range.startYmd, range.endYmd);
    const title = document.createElement('p');
    title.className = 'text-[11px] text-slate-600 dark:text-orange-100/90 m-0 mt-0.5 leading-snug break-words';
    title.textContent = range.title || '—';
    body.appendChild(dates);
    body.appendChild(title);
    card.appendChild(body);

    if (!editable) return card;

    return mountPlanningSwipeCard(card, {
        enabled: true,
        mode: 'delete-only',
        onEdit: () => openClosureEdit(index),
        onDelete: () => {
            if (!window.confirm('Supprimer cette période de fermeture ?')) return;
            void deleteClosureAt(index);
        }
    });
}

function renderClosureCards() {
    const host = document.getElementById('fermetures-list');
    if (!host) return;
    host.replaceChildren();
    const u = getPlanningSessionUser();
    const editable = canEditClosures(u);

    if (!closureRanges.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-500 dark:text-slate-400 italic m-0 py-2';
        empty.textContent = editable
            ? 'Aucune période. Utilisez « + Période de fermeture ».'
            : 'Aucune période de fermeture définie.';
        host.appendChild(empty);
        return;
    }

    closureRanges.forEach((r, i) => {
        host.appendChild(buildClosureCard(r, i, editable));
    });
}

function showFermeturesMainPanel() {
    document.getElementById('fermetures-main-panel')?.classList.remove('hidden');
    const edit = document.getElementById('fermetures-edit-panel');
    edit?.classList.add('hidden');
    edit?.setAttribute('aria-hidden', 'true');
    editingClosureIndex = null;
    setPlanningRouteBackHandler('modal_fermetures', null);
    updatePlanningRouteDialog('modal_fermetures', 'Fermetures', 'Menu');
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
            el.classList.toggle('opacity-70', readonly);
        }
    }
}

async function persistClosures() {
    const u = getPlanningSessionUser();
    if (!canEditClosures(u)) return;
    const r = await saveTemplateClosureRanges(closureRanges);
    if (!r.ok) {
        showToast(r.error || 'Enregistrement impossible.', 'error');
    }
}

function schedulePersist() {
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => void persistClosures(), 600);
}

function openClosureEdit(index) {
    const u = getPlanningSessionUser();
    const editable = canEditClosures(u);
    editingClosureIndex = index;
    const range = index >= 0 ? closureRanges[index] : { startYmd: '', endYmd: '', title: '' };

    document.getElementById('fermetures-main-panel')?.classList.add('hidden');
    const panel = document.getElementById('fermetures-edit-panel');
    panel?.classList.remove('hidden');
    panel?.setAttribute('aria-hidden', 'false');

    applyEditForm(range);
    setEditFieldsReadonly(!editable);

    const title =
        index < 0 ? 'Fermetures / Nouvelle période' : editable ? 'Fermetures / Édition' : 'Fermetures / Détail';
    setPlanningRouteBackHandler('modal_fermetures', showFermeturesMainPanel);
    updatePlanningRouteDialog('modal_fermetures', title, 'Fermetures');
}

async function saveEditPanel() {
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
    const entry = { startYmd: f.startYmd, endYmd: f.endYmd, ...(f.title ? { title: f.title } : {}) };
    if (editingClosureIndex === null || editingClosureIndex < 0) {
        closureRanges.push(entry);
    } else {
        closureRanges[editingClosureIndex] = entry;
    }
    closureRanges.sort((a, b) => a.startYmd.localeCompare(b.startYmd));
    await persistClosures();
    showFermeturesMainPanel();
}

async function deleteClosureAt(index) {
    const u = getPlanningSessionUser();
    if (!canEditClosures(u)) return;
    if (index < 0 || index >= closureRanges.length) return;
    closureRanges.splice(index, 1);
    await persistClosures();
    showFermeturesMainPanel();
}

export async function loadClosureRangesFromServer() {
    await fetchOrganSchoolSettings();
    closureRanges = parseClosureRangesFromSettings(
        getOrganSchoolSettingsCached()?.template_apply_closure_ranges
    );
}

export async function openFermeturesModal() {
    await loadClosureRangesFromServer();
    showFermeturesMainPanel();
    const u = getPlanningSessionUser();
    document.getElementById('fermetures-add-wrap')?.classList.toggle('hidden', !canEditClosures(u));
}

export function resetFermeturesUiBindings() {
    bound = false;
    closureRanges = [];
    editingClosureIndex = null;
}

export function initFermeturesUi() {
    if (!isBackendAuthConfigured() || bound) return;
    bound = true;

    document.getElementById('menu-item-fermetures')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!openPlanningRouteFromDrawer('modal_fermetures', 'Fermetures', 'Menu')) return;
        void openFermeturesModal();
    });

    document.getElementById('fermetures-add')?.addEventListener('click', () => {
        openClosureEdit(-1);
    });

    const onEditFieldChange = () => {
        if (!canEditClosures(getPlanningSessionUser())) return;
        const f = readEditForm();
        if (!f.startYmd || !f.endYmd || f.endYmd < f.startYmd) return;
        const entry = {
            startYmd: f.startYmd,
            endYmd: f.endYmd,
            ...(f.title ? { title: f.title } : {})
        };
        if (editingClosureIndex === null || editingClosureIndex < 0) {
            closureRanges.push(entry);
            closureRanges.sort((a, b) => a.startYmd.localeCompare(b.startYmd));
            editingClosureIndex = closureRanges.findIndex(
                (r) => r.startYmd === entry.startYmd && r.endYmd === entry.endYmd
            );
        } else {
            closureRanges[editingClosureIndex] = entry;
        }
        schedulePersist();
    };
    for (const id of ['fermeture-edit-start', 'fermeture-edit-end', 'fermeture-edit-title']) {
        document.getElementById(id)?.addEventListener('change', onEditFieldChange);
    }
    document.getElementById('fermeture-edit-title')?.addEventListener('input', onEditFieldChange);

    document.getElementById('modal_fermetures')?.addEventListener('close', () => {
        showFermeturesMainPanel();
    });
}
