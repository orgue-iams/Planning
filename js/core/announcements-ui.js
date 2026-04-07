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
import { formatSimpleRichHtml } from '../utils/rich-text.js';

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

function wrapSelectionWith(before, after = before) {
    const body = document.getElementById('ann-body');
    if (!(body instanceof HTMLTextAreaElement)) return;
    const start = body.selectionStart ?? 0;
    const end = body.selectionEnd ?? 0;
    const selected = body.value.slice(start, end);
    const payload = `${before}${selected}${after}`;
    body.setRangeText(payload, start, end, 'end');
    body.focus();
}

function getAnnBodyHtml() {
    const body = document.getElementById('ann-body');
    if (!(body instanceof HTMLTextAreaElement)) return '';
    return body.value || '';
}

function clearAnnBody() {
    const body = document.getElementById('ann-body');
    if (!(body instanceof HTMLTextAreaElement)) return;
    body.value = '';
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
        if (prev) prev.innerHTML = formatSimpleRichHtml(r.body || '');
        wrap.appendChild(div);
    }
}

let announcementsHandlersBound = false;

export function initAnnouncementsUi(currentUser) {
    const show = isBackendAuthConfigured() && isPrivilegedUser(currentUser);
    document.getElementById('menu-item-announcements-wrap')?.classList.toggle('hidden', !show);
    if (!show || announcementsHandlersBound) return;
    announcementsHandlersBound = true;

    document.getElementById('menu-item-announcements')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        presetAnnouncementDateInputs();
        document.getElementById('modal_announcements')?.showModal();
        void renderList();
    });

    document.getElementById('ann-btn-bold')?.addEventListener('click', () => wrapSelectionWith('<strong>', '</strong>'));
    document.getElementById('ann-btn-italic')?.addEventListener('click', () => wrapSelectionWith('<em>', '</em>'));
    document.getElementById('ann-btn-underline')?.addEventListener('click', () => wrapSelectionWith('<u>', '</u>'));

    document.getElementById('ann-publish-btn')?.addEventListener('click', async () => {
        const body = getAnnBodyHtml();
        const channel = document.getElementById('ann-channel')?.value || 'login';
        const starts = fromLocalInputValue(document.getElementById('ann-start')?.value || '');
        const ends = fromLocalInputValue(document.getElementById('ann-end')?.value || '');
        if (!body.trim()) {
            showToast('Saisissez un message.', 'error');
            return;
        }
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
        clearAnnBody();
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
