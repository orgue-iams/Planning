/**
 * Annonces planifiées (admin + prof) — table scheduled_messages.
 */
import { isPrivilegedUser } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import {
    replaceLoginAnnouncementRemote,
    fetchLatestLoginAnnouncementForEdit
} from '../utils/org-content.js';
import { showToast } from '../utils/toast.js';
import { normalizeQuillMarkup, sanitizeRulesHtml } from '../utils/rich-text.js';
import {
    createPlanningQuill,
    destroyPlanningQuillMount,
    isQuillAvailable,
    quillGetPlainText,
    quillSetHtml
} from '../utils/planning-quill.js';
import { openPlanningRouteDialog } from '../utils/planning-route-dialog.js';
import { closePlanningDrawer } from './planning-drawer-ui.js';

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** @param {string | null | undefined} iso @param {HTMLInputElement | null} dateEl */
function setBoundsFromIso(iso, dateEl) {
    if (!dateEl) return;
    if (!iso) {
        dateEl.value = '';
        return;
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        dateEl.value = '';
        return;
    }
    dateEl.value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Journées entières : début 00:00 local, fin 23:59:59.999 local.
 * @returns {{ starts: string | null, ends: string | null }}
 */
function readBoundsIso() {
    const sd = document.getElementById('ann-start-date')?.value?.trim();
    const ed = document.getElementById('ann-end-date')?.value?.trim();
    if (!sd || !ed) return { starts: null, ends: null };
    const ds = new Date(`${sd}T00:00:00`);
    const de = new Date(`${ed}T23:59:59.999`);
    if (Number.isNaN(ds.getTime()) || Number.isNaN(de.getTime())) return { starts: null, ends: null };
    return { starts: ds.toISOString(), ends: de.toISOString() };
}

/** @type {AbortController | null} */
let annUiAbort = null;
/** @type {any} */
let annQuill = null;

/** Dernier état enregistré avec succès (évite requêtes inutiles au blur). */
let lastPersisted = { sd: '', ed: '', body: '' };

function getAnnFormState() {
    const sd = document.getElementById('ann-start-date')?.value?.trim() ?? '';
    const ed = document.getElementById('ann-end-date')?.value?.trim() ?? '';
    const body =
        annQuill?.root
            ? sanitizeRulesHtml(normalizeQuillMarkup(String(annQuill.root.innerHTML)))
            : '';
    return { sd, ed, body };
}

function formStateEquals(a, b) {
    return a.sd === b.sd && a.ed === b.ed && a.body === b.body;
}

/**
 * @param {{ silent?: boolean } | undefined} opts silent : pas de toast de succès (sauvegarde auto).
 */
async function persistAnnouncement(opts = {}) {
    const { silent = false } = opts;
    const state = getAnnFormState();
    if (formStateEquals(state, lastPersisted)) {
        return { ok: true, skipped: true };
    }

    const plain = annQuill ? quillGetPlainText(annQuill) : '';
    if (!plain) {
        const res = await replaceLoginAnnouncementRemote({ body: '', startsAt: null, endsAt: null });
        if (!res.ok) {
            if (!silent) showToast(res.error || 'Erreur', 'error');
            return res;
        }
        const sdEl = document.getElementById('ann-start-date');
        const edEl = document.getElementById('ann-end-date');
        if (sdEl) sdEl.value = '';
        if (edEl) edEl.value = '';
        lastPersisted = { sd: '', ed: '', body: '' };
        if (!silent) showToast('Annonce effacée (aucun message sur l’écran de connexion).');
        return res;
    }

    const { starts, ends } = readBoundsIso();
    if (!starts || !ends) {
        showToast('Indiquez une date de début et une date de fin.', 'error');
        return { ok: false, error: 'dates' };
    }
    if (new Date(ends) <= new Date(starts)) {
        showToast('La date de fin doit être après la date de début.', 'error');
        return { ok: false, error: 'order' };
    }

    const res = await replaceLoginAnnouncementRemote({ body: state.body, startsAt: starts, endsAt: ends });
    if (!res.ok) {
        if (!silent) showToast(res.error || 'Erreur', 'error');
        return res;
    }
    let row = res.row;
    if (!row) {
        row = await fetchLatestLoginAnnouncementForEdit();
    }
    if (row?.body != null && annQuill) {
        quillSetHtml(annQuill, sanitizeRulesHtml(normalizeQuillMarkup(String(row.body))));
        const sd = document.getElementById('ann-start-date');
        const ed = document.getElementById('ann-end-date');
        setBoundsFromIso(row.starts_at, sd);
        setBoundsFromIso(row.ends_at, ed);
    }
    lastPersisted = getAnnFormState();
    if (!silent) showToast('Annonce enregistrée.');
    return res;
}

/** Sauvegarde après sortie du focus hors de la modale annonces (évite sauvegarde en passant sur la barre Quill). */
function scheduleMaybePersistBlur() {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const m = document.getElementById('modal_announcements');
            if (!(m instanceof HTMLDialogElement) || !m.open) return;
            if (m.contains(document.activeElement)) return;
            void persistAnnouncement({ silent: true });
        });
    });
}

export function resetAnnouncementsUiBindings() {
    annUiAbort?.abort();
    annUiAbort = null;
}

export function initAnnouncementsUi(currentUser) {
    const show = isBackendAuthConfigured() && isPrivilegedUser(currentUser);
    document.getElementById('menu-item-announcements-wrap')?.classList.toggle('hidden', !show);
    if (!show) return;

    annUiAbort?.abort();
    annUiAbort = new AbortController();
    const { signal } = annUiAbort;

    const modal = document.getElementById('modal_announcements');
    const mount = document.getElementById('ann-quill-mount');

    const ensureAnnQuill = () => {
        if (!(mount instanceof HTMLElement)) return null;
        if (!isQuillAvailable()) {
            showToast('Éditeur indisponible. Rechargez la page.', 'error');
            return null;
        }
        annQuill = null;
        annQuill = createPlanningQuill(mount, {
            placeholder: 'Votre message…',
            compactAnnouncementToolbar: true
        });
        if (annQuill?.root) {
            annQuill.root.addEventListener('blur', () => scheduleMaybePersistBlur(), { signal });
        }
        return annQuill;
    };

    modal?.addEventListener(
        'close',
        async () => {
            await persistAnnouncement({ silent: true });
            annQuill = null;
            if (mount instanceof HTMLElement) destroyPlanningQuillMount(mount);
        },
        { signal }
    );

    document.getElementById('menu-item-announcements')?.addEventListener(
        'click',
        async (e) => {
            e.preventDefault();
            closePlanningDrawer();
            document.getElementById('btn-app-drawer')?.blur();
            const latest = await fetchLatestLoginAnnouncementForEdit();
            ensureAnnQuill();
            if (!annQuill) {
                openPlanningRouteDialog('modal_announcements', 'Annonces', 'Annonces');
                return;
            }
            const sd = document.getElementById('ann-start-date');
            const ed = document.getElementById('ann-end-date');
            if (latest) {
                setBoundsFromIso(latest.starts_at, sd);
                setBoundsFromIso(latest.ends_at, ed);
                const prepared = sanitizeRulesHtml(normalizeQuillMarkup(String(latest.body ?? '')));
                quillSetHtml(annQuill, prepared);
            } else {
                presetAnnouncementDateInputs(true);
                quillSetHtml(annQuill, '');
            }
            lastPersisted = getAnnFormState();
            openPlanningRouteDialog('modal_announcements', 'Annonces', 'Annonces');
        },
        { signal }
    );

    document.getElementById('ann-start-date')?.addEventListener('blur', () => scheduleMaybePersistBlur(), { signal });
    document.getElementById('ann-end-date')?.addEventListener('blur', () => scheduleMaybePersistBlur(), { signal });

    document.getElementById('ann-clear-all-btn')?.addEventListener(
        'click',
        async () => {
            if (!annQuill) ensureAnnQuill();
            if (!annQuill) return;
            const sdEl = document.getElementById('ann-start-date');
            const edEl = document.getElementById('ann-end-date');
            if (sdEl) sdEl.value = '';
            if (edEl) edEl.value = '';
            quillSetHtml(annQuill, '');
            const res = await replaceLoginAnnouncementRemote({ body: '', startsAt: null, endsAt: null });
            if (!res.ok) {
                showToast(res.error || 'Erreur', 'error');
                return;
            }
            lastPersisted = { sd: '', ed: '', body: '' };
            showToast('Texte et dates effacés (aucune annonce sur l’écran de connexion).');
        },
        { signal }
    );
}

/**
 * @param {boolean} [force] — quand true, réinitialise les dates même si déjà remplies (réouverture modale).
 */
export function presetAnnouncementDateInputs(force = false) {
    const sd = document.getElementById('ann-start-date');
    const ed = document.getElementById('ann-end-date');
    if (!sd || !ed) return;
    if (!force && sd.value) return;
    const a = new Date();
    a.setHours(0, 0, 0, 0);
    const b = new Date(a);
    b.setDate(b.getDate() + 7);
    sd.value = `${a.getFullYear()}-${pad2(a.getMonth() + 1)}-${pad2(a.getDate())}`;
    ed.value = `${b.getFullYear()}-${pad2(b.getMonth() + 1)}-${pad2(b.getDate())}`;
}
