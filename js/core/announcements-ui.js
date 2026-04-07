/**
 * Annonces planifiées (admin + prof) — table scheduled_messages.
 */
import { isPrivilegedUser } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import {
    listScheduledMessagesRemote,
    insertScheduledMessageRemote,
    deleteScheduledMessageRemote
} from '../utils/org-content.js';
import { showToast } from '../utils/toast.js';
import { formatSimpleRichHtml, normalizeQuillMarkup, sanitizeRulesHtml } from '../utils/rich-text.js';
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

async function renderList() {
    const wrap = document.getElementById('ann-list');
    if (!wrap) return;
    const rows = await listScheduledMessagesRemote();
    wrap.replaceChildren();
    if (!rows.length) {
        wrap.innerHTML = '<p class="text-slate-400 text-center py-4">Aucun message enregistré.</p>';
        return;
    }
    for (const r of rows) {
        const div = document.createElement('div');
        div.className = 'rounded-lg border border-slate-200 bg-white p-2';
        const ch = r.channel === 'login' ? 'Connexion' : 'Après login';
        div.innerHTML = `
            <div class="flex justify-between items-start gap-2">
                <div>
                    <p class="font-black text-[10px] text-slate-600">${ch}</p>
                    <p class="text-[9px] text-slate-400">${r.starts_at?.slice(0, 16)} → ${r.ends_at?.slice(0, 16)}</p>
                </div>
                <button type="button" class="btn btn-ghost btn-xs text-error font-black text-[9px] ann-del" data-id="${r.id}">Suppr.</button>
            </div>
            <div class="text-slate-700 mt-1 text-[11px] leading-snug ann-preview"></div>`;
        const prev = div.querySelector('.ann-preview');
        if (prev) prev.innerHTML = `<div class="organ-rich">${formatSimpleRichHtml(r.body || '')}</div>`;
        wrap.appendChild(div);
    }
}

let announcementsHandlersBound = false;
/** @type {any} */
let annQuill = null;

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
            showToast("Éditeur indisponible. Rechargez la page.", 'error');
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

    document.getElementById('menu-item-announcements')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        presetAnnouncementDateInputs();
        void ensureAnnQuill();
        modal?.showModal();
        void renderList();
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
        const channel = document.getElementById('ann-channel')?.value || 'login';
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
        const res = await insertScheduledMessageRemote({ body, startsAt: starts, endsAt: ends, channel });
        if (!res.ok) {
            showToast(res.error || 'Erreur', 'error');
            return;
        }
        showToast('Annonce enregistrée.');
        quillSetHtml(annQuill, '');
        await renderList();
    });

    document.getElementById('ann-list')?.addEventListener('click', async (ev) => {
        const btn = ev.target?.closest?.('.ann-del');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        if (!id || !confirm('Supprimer cette annonce ?')) return;
        const res = await deleteScheduledMessageRemote(id);
        if (!res.ok) {
            showToast(res.error || 'Erreur', 'error');
            return;
        }
        showToast('Supprimé.');
        await renderList();
    });
}

/** Valeurs par défaut pour les champs datetime (prochaine heure → +7 jours). */
export function presetAnnouncementDateInputs() {
    const start = document.getElementById('ann-start');
    const end = document.getElementById('ann-end');
    if (!start || !end || start.value) return;
    const a = new Date();
    a.setMinutes(0, 0, 0);
    const b = new Date(a);
    b.setDate(b.getDate() + 7);
    start.value = toLocalInputValue(a.toISOString());
    end.value = toLocalInputValue(b.toISOString());
}
