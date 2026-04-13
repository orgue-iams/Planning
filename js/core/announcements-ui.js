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
import { normalizeHHmmInput } from '../utils/time-helpers.js';

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** @param {string | null | undefined} iso */
function setBoundsFromIso(iso, dateEl, timeEl) {
    if (!dateEl || !timeEl) return;
    if (!iso) {
        dateEl.value = '';
        timeEl.value = '';
        return;
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        dateEl.value = '';
        timeEl.value = '';
        return;
    }
    dateEl.value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    timeEl.value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * @returns {{ starts: string | null, ends: string | null }}
 */
function readBoundsIso() {
    const sd = document.getElementById('ann-start-date')?.value?.trim();
    const st = normalizeHHmmInput(document.getElementById('ann-start-time')?.value);
    const ed = document.getElementById('ann-end-date')?.value?.trim();
    const et = normalizeHHmmInput(document.getElementById('ann-end-time')?.value);
    if (!sd || !st || !ed || !et) return { starts: null, ends: null };
    const ds = new Date(`${sd}T${st}:00`);
    const de = new Date(`${ed}T${et}:00`);
    if (Number.isNaN(ds.getTime()) || Number.isNaN(de.getTime())) return { starts: null, ends: null };
    return { starts: ds.toISOString(), ends: de.toISOString() };
}

/** @type {AbortController | null} */
let annUiAbort = null;
/** @type {any} */
let annQuill = null;

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
            adminFontStepper: currentUser?.role === 'admin'
        });
        return annQuill;
    };

    modal?.addEventListener(
        'close',
        () => {
            annQuill = null;
            if (mount instanceof HTMLElement) destroyPlanningQuillMount(mount);
        },
        { signal }
    );

    document.getElementById('menu-item-announcements')?.addEventListener(
        'click',
        async (e) => {
            e.preventDefault();
            document.getElementById('btn-user-menu')?.blur();
            /* Charger d’abord, puis créer Quill une seule fois (évite barres dupliquées si fermeture pendant le fetch). */
            const latest = await fetchLatestLoginAnnouncementForEdit();
            ensureAnnQuill();
            if (!annQuill) {
                modal?.showModal();
                return;
            }
            const sd = document.getElementById('ann-start-date');
            const st = document.getElementById('ann-start-time');
            const ed = document.getElementById('ann-end-date');
            const et = document.getElementById('ann-end-time');
            if (latest) {
                setBoundsFromIso(latest.starts_at, sd, st);
                setBoundsFromIso(latest.ends_at, ed, et);
                const prepared = sanitizeRulesHtml(normalizeQuillMarkup(String(latest.body ?? '')));
                quillSetHtml(annQuill, prepared);
            } else {
                presetAnnouncementDateInputs(true);
                quillSetHtml(annQuill, '');
            }
            modal?.showModal();
        },
        { signal }
    );

    document.getElementById('ann-publish-btn')?.addEventListener(
        'click',
        async () => {
            if (!annQuill) {
                ensureAnnQuill();
            }
            if (!annQuill) return;
            const body = sanitizeRulesHtml(normalizeQuillMarkup(annQuill.root.innerHTML));
            if (!quillGetPlainText(annQuill)) {
                showToast('Saisissez un message.', 'error');
                return;
            }
            const { starts, ends } = readBoundsIso();
            if (!starts || !ends) {
                showToast('Indiquez début et fin (date + heure au format 24 h, ex. 08:00 ou 20:00).', 'error');
                return;
            }
            if (new Date(ends) <= new Date(starts)) {
                showToast('La fin doit être après le début.', 'error');
                return;
            }
            const res = await replaceLoginAnnouncementRemote({ body, startsAt: starts, endsAt: ends });
            if (!res.ok) {
                showToast(res.error || 'Erreur', 'error');
                return;
            }
            showToast('Annonce publiée (l’ancienne annonce est remplacée).');
            /* Afficher exactement ce qui est en base (évite écran vide ou texte obsolète à la réouverture). */
            let row = res.row;
            if (!row) {
                row = await fetchLatestLoginAnnouncementForEdit();
            }
            if (row?.body != null && annQuill) {
                quillSetHtml(annQuill, sanitizeRulesHtml(normalizeQuillMarkup(String(row.body))));
                const sd = document.getElementById('ann-start-date');
                const st = document.getElementById('ann-start-time');
                const ed = document.getElementById('ann-end-date');
                const et = document.getElementById('ann-end-time');
                setBoundsFromIso(row.starts_at, sd, st);
                setBoundsFromIso(row.ends_at, ed, et);
            }
        },
        { signal }
    );
}

/**
 * @param {boolean} [force] — quand true, réinitialise les dates même si déjà remplies (réouverture modale).
 */
export function presetAnnouncementDateInputs(force = false) {
    const sd = document.getElementById('ann-start-date');
    const st = document.getElementById('ann-start-time');
    const ed = document.getElementById('ann-end-date');
    const et = document.getElementById('ann-end-time');
    if (!sd || !st || !ed || !et) return;
    if (!force && sd.value) return;
    const a = new Date();
    a.setMinutes(0, 0, 0);
    const b = new Date(a);
    b.setDate(b.getDate() + 7);
    sd.value = `${a.getFullYear()}-${pad2(a.getMonth() + 1)}-${pad2(a.getDate())}`;
    st.value = `${pad2(a.getHours())}:${pad2(a.getMinutes())}`;
    ed.value = `${b.getFullYear()}-${pad2(b.getMonth() + 1)}-${pad2(b.getDate())}`;
    et.value = `${pad2(b.getHours())}:${pad2(b.getMinutes())}`;
}
