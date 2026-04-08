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

let announcementsHandlersBound = false;
/** @type {any} */
let annQuill = null;

export function resetAnnouncementsUiBindings() {
    announcementsHandlersBound = false;
}

export function initAnnouncementsUi(currentUser) {
    const show = isBackendAuthConfigured() && isPrivilegedUser(currentUser);
    document.getElementById('menu-item-announcements-wrap')?.classList.toggle('hidden', !show);
    if (!show || announcementsHandlersBound) return;
    announcementsHandlersBound = true;

    const modal = document.getElementById('modal_announcements');
    const mount = document.getElementById('ann-quill-mount');

    const ensureAnnQuill = () => {
        if (!(mount instanceof HTMLElement)) return null;
        if (!isQuillAvailable()) {
            showToast('Éditeur indisponible. Rechargez la page.', 'error');
            return null;
        }
        destroyPlanningQuillMount(mount);
        annQuill = createPlanningQuill(mount, {
            placeholder: 'Votre message…'
        });
        return annQuill;
    };

    modal?.addEventListener('close', () => {
        if (mount instanceof HTMLElement) destroyPlanningQuillMount(mount);
        annQuill = null;
    });

    document.getElementById('menu-item-announcements')?.addEventListener('click', async (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        void ensureAnnQuill();
        const latest = await fetchLatestLoginAnnouncementForEdit();
        if (latest?.body && annQuill) {
            quillSetHtml(annQuill, sanitizeRulesHtml(latest.body));
            const start = document.getElementById('ann-start');
            const end = document.getElementById('ann-end');
            if (start && latest.starts_at) start.value = toLocalInputValue(latest.starts_at);
            if (end && latest.ends_at) end.value = toLocalInputValue(latest.ends_at);
        } else {
            presetAnnouncementDateInputs(true);
            if (annQuill) quillSetHtml(annQuill, '');
        }
        modal?.showModal();
    });

    document.getElementById('ann-publish-btn')?.addEventListener('click', async () => {
        if (!annQuill) {
            void ensureAnnQuill();
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
        quillSetHtml(annQuill, '');
    });
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
