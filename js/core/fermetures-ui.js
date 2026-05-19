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
    planningRouteTitle,
    pushPlanningRouteLevel
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
    const opts = { day: 'numeric', month: 'long', year: 'numeric' };
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
    body.appendChild(dates);
    const titleText = String(range.title || '').trim();
    if (titleText) {
        title.textContent = titleText;
        body.appendChild(title);
    }
    card.appendChild(body);

    if (!editable) return card;

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

function todayYmdLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Fermetures dont la date de fin est aujourd’hui ou plus tard. */
function futureClosureRanges() {
    const today = todayYmdLocal();
    return closureRanges.filter((r) => String(r.endYmd || '') >= today);
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

function showFermeturesMainPanel() {
    document.getElementById('fermetures-main-panel')?.classList.remove('hidden');
    const edit = document.getElementById('fermetures-edit-panel');
    edit?.classList.add('hidden');
    edit?.setAttribute('aria-hidden', 'true');
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
        index < 0
            ? planningRouteTitle('Nouvelle période')
            : editable
              ? planningRouteTitle('Édition')
              : planningRouteTitle('Détail');
    pushPlanningRouteLevel('modal_fermetures', title, 'Fermetures', showFermeturesMainPanel);
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
    const u = getPlanningSessionUser();
    if (!canEditClosures(u)) {
        showToast('Fermetures : réservé à l’administration et aux professeurs.', 'info');
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
}

export function initFermeturesUi() {
    if (!isBackendAuthConfigured() || bound) return;
    bound = true;

    document.getElementById('menu-item-fermetures')?.addEventListener('click', (e) => {
        e.preventDefault();
        const u = getPlanningSessionUser();
        if (!canEditClosures(u)) {
            showToast('Fermetures : réservé à l’administration et aux professeurs.', 'info');
            return;
        }
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
        if (saveDebounce) {
            clearTimeout(saveDebounce);
            saveDebounce = null;
        }
        void persistClosures();
    });

    document.addEventListener('planning-overlay-flush', () => {
        if (saveDebounce) {
            clearTimeout(saveDebounce);
            saveDebounce = null;
        }
        void persistClosures();
    });

    for (const id of ['fermeture-edit-start', 'fermeture-edit-end', 'fermeture-edit-title']) {
        document.getElementById(id)?.addEventListener('blur', onEditFieldChange);
    }
}
