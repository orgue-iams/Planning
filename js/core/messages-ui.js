/**
 * Modale Règles + popup annonce après connexion (localStorage en démo, Supabase en prod).
 */

import { showToast } from '../utils/toast.js';
import {
    getRulesText,
    setRulesText,
    getBroadcast,
    publishBroadcast,
    markBroadcastSeen,
    shouldShowBroadcast
} from '../utils/messaging.js';
import { isPrivilegedUser } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { fetchOrganRulesRemote, saveOrganRulesRemote, fetchActiveAfterLoginMessage } from '../utils/org-content.js';
import { formatSimpleRichHtml, formatRichContentHtml } from '../utils/rich-text.js';

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderRulesView(text) {
    const el = document.getElementById('rules-view');
    if (!el) return;
    el.innerHTML = formatRichContentHtml(text);
}

export function initMessagesUi(currentUser) {
    const btnRules = document.getElementById('btn-rules');
    const modalRules = document.getElementById('modal_rules');
    const modalBroadcast = document.getElementById('modal_broadcast');

    const view = document.getElementById('rules-view');
    const editWrap = document.getElementById('rules-edit-wrap');
    const editor = document.getElementById('rules-editor');
    const btnEdit = document.getElementById('rules-btn-edit');
    const btnSave = document.getElementById('rules-btn-save');
    const btnCancel = document.getElementById('rules-btn-cancel');
    const btnClose = document.getElementById('rules-btn-close');

    const adminBlock = document.getElementById('rules-admin-broadcast');
    const broadcastEditor = document.getElementById('broadcast-editor');
    const btnPublish = document.getElementById('broadcast-publish');
    const backendHint = document.getElementById('rules-backend-hint');

    const priv = isPrivilegedUser(currentUser);
    const backend = isBackendAuthConfigured();

    if (priv) {
        btnEdit?.classList.remove('hidden');
        if (backend) {
            adminBlock?.classList.add('hidden');
            backendHint?.classList.remove('hidden');
        } else {
            adminBlock?.classList.remove('hidden');
            backendHint?.classList.add('hidden');
            const b = getBroadcast();
            if (broadcastEditor) broadcastEditor.value = b?.text || '';
        }
    } else {
        btnEdit?.classList.add('hidden');
        adminBlock?.classList.add('hidden');
        backendHint?.classList.add('hidden');
    }

    btnRules?.addEventListener('click', async () => {
        let text = getRulesText();
        if (backend) {
            const remote = await fetchOrganRulesRemote();
            if (remote !== null && remote !== '') text = remote;
        }
        renderRulesView(text);
        if (editor) editor.value = text;
        editWrap?.classList.add('hidden');
        view?.classList.remove('hidden');
        btnSave?.classList.add('hidden');
        btnCancel?.classList.add('hidden');
        btnEdit?.classList.toggle('hidden', !priv);
        modalRules?.showModal();
    });

    btnClose?.addEventListener('click', () => modalRules?.close());

    btnEdit?.addEventListener('click', async () => {
        let text = getRulesText();
        if (backend) {
            const r = await fetchOrganRulesRemote();
            if (r !== null) text = r;
        }
        if (editor) editor.value = text;
        view?.classList.add('hidden');
        editWrap?.classList.remove('hidden');
        btnEdit?.classList.add('hidden');
        btnSave?.classList.remove('hidden');
        btnCancel?.classList.remove('hidden');
        editor?.focus();
    });

    btnCancel?.addEventListener('click', () => {
        editWrap?.classList.add('hidden');
        view?.classList.remove('hidden');
        btnEdit?.classList.remove('hidden');
        btnSave?.classList.add('hidden');
        btnCancel?.classList.add('hidden');
        const t = editor?.value ?? getRulesText();
        renderRulesView(t);
    });

    btnSave?.addEventListener('click', async () => {
        const t = editor?.value ?? '';
        if (backend) {
            const res = await saveOrganRulesRemote(t);
            if (!res.ok) {
                showToast(res.error || 'Erreur', 'error');
                return;
            }
        } else {
            setRulesText(t);
        }
        editWrap?.classList.add('hidden');
        view?.classList.remove('hidden');
        btnEdit?.classList.remove('hidden');
        btnSave?.classList.add('hidden');
        btnCancel?.classList.add('hidden');
        renderRulesView(t);
        showToast('Règles enregistrées.');
    });

    btnPublish?.addEventListener('click', () => {
        if (backend) return;
        const t = broadcastEditor?.value ?? '';
        publishBroadcast(t);
        showToast(t ? 'Annonce publiée (visible aux élèves et profs).' : 'Annonce effacée.');
    });

    const btnBroadcastOk = document.getElementById('broadcast-btn-ok');

    btnBroadcastOk?.addEventListener('click', () => {
        const id = modalBroadcast?.dataset.broadcastId;
        if (id) {
            if (id.startsWith('sm_')) {
                localStorage.setItem(`orgue_sm_seen_${id.slice(3)}`, '1');
            } else {
                markBroadcastSeen(id);
            }
        }
        modalBroadcast?.close();
    });
}

export async function tryShowBroadcastPopup(currentUser) {
    const modal = document.getElementById('modal_broadcast');
    const body = document.getElementById('broadcast-body');
    if (!modal || !body) return;

    if (isBackendAuthConfigured()) {
        if (!currentUser || currentUser.role === 'admin') return;
        if (currentUser.role !== 'eleve' && currentUser.role !== 'prof') return;
        const m = await fetchActiveAfterLoginMessage();
        if (!m?.body) return;
        if (localStorage.getItem(`orgue_sm_seen_${m.id}`) === '1') return;
        modal.dataset.broadcastId = `sm_${m.id}`;
        body.innerHTML = formatSimpleRichHtml(m.body);
        modal.showModal();
        return;
    }

    if (!shouldShowBroadcast(currentUser)) return;
    const b = getBroadcast();
    if (!b) return;
    modal.dataset.broadcastId = b.id;
    body.innerHTML = escapeHtml(b.text).replace(/\n/g, '<br>');
    modal.showModal();
}
