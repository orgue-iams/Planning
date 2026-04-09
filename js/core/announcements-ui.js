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

function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(s) {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
        annQuill = createPlanningQuill(mount, { placeholder: 'Votre message…' });
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
            if (latest) {
                const start = document.getElementById('ann-start');
                const end = document.getElementById('ann-end');
                if (start && latest.starts_at) start.value = toLocalInputValue(latest.starts_at);
                if (end && latest.ends_at) end.value = toLocalInputValue(latest.ends_at);
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
            const starts = fromLocalInputValue(document.getElementById('ann-start')?.value || '');
            const ends = fromLocalInputValue(document.getElementById('ann-end')?.value || '');
            if (!starts || !ends) {
                showToast('Indiquez début et fin.', 'error');
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
                const startEl = document.getElementById('ann-start');
                const endEl = document.getElementById('ann-end');
                if (startEl && row.starts_at) startEl.value = toLocalInputValue(row.starts_at);
                if (endEl && row.ends_at) endEl.value = toLocalInputValue(row.ends_at);
            }
        },
        { signal }
    );
}

/**
 * @param {boolean} [force] — quand true, réinitialise les dates même si déjà remplies (réouverture modale).
 */
export function presetAnnouncementDateInputs(force = false) {
    const start = document.getElementById('ann-start');
    const end = document.getElementById('ann-end');
    if (!start || !end) return;
    if (!force && start.value) return;
    const a = new Date();
    a.setMinutes(0, 0, 0);
    const b = new Date(a);
    b.setDate(b.getDate() + 7);
    start.value = toLocalInputValue(a.toISOString());
    end.value = toLocalInputValue(b.toISOString());
}
