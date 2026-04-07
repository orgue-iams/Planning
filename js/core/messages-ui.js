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
import { formatSimpleRichHtml, looksLikeHtml, plainTextToSafeHtml, sanitizeRulesHtml } from '../utils/rich-text.js';

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderRulesView(text) {
    const el = document.getElementById('rules-view');
    if (!el) return;
    const raw = String(text ?? '');
    el.innerHTML = looksLikeHtml(raw) ? sanitizeRulesHtml(raw) : plainTextToSafeHtml(raw);
}

function ensureFallbackRulesModal() {
    let dlg = document.getElementById('modal_rules_fallback');
    if (!(dlg instanceof HTMLDialogElement)) {
        const host = document.getElementById('app-modals') || document.body;
        if (!host) return null;
        dlg = document.createElement('dialog');
        dlg.id = 'modal_rules_fallback';
        dlg.className = 'modal';
        dlg.innerHTML = `
            <div class="modal-box max-w-2xl w-[94%] max-h-[90dvh] flex flex-col border border-slate-200 rounded-2xl">
                <h3 class="font-black text-sm uppercase tracking-wide text-slate-600 border-b pb-2 shrink-0">Règles d'utilisation de l'orgue</h3>
                <div id="rules-fallback-view" class="text-sm text-slate-700 leading-relaxed py-4 overflow-y-auto flex-1 min-h-0"></div>
                <div class="modal-action shrink-0 border-t border-slate-100 mt-2 pt-3">
                    <button type="button" id="rules-fallback-close" class="btn btn-ghost btn-sm font-black text-[11px] ml-auto">Fermer</button>
                </div>
            </div>
        `;
        host.appendChild(dlg);
        dlg.querySelector('#rules-fallback-close')?.addEventListener('click', () => dlg?.close());
    }
    return dlg;
}

export function initMessagesUi(currentUser) {
    const btnRules = document.getElementById('btn-rules') || document.querySelector('#app-header #btn-rules');
    const modalRules = document.getElementById('modal_rules');
    const modalBroadcast = document.getElementById('modal_broadcast');

    const view = document.getElementById('rules-view');
    const editWrap = document.getElementById('rules-edit-wrap');
    const editor = document.getElementById('rules-editor');
    const toolbar = document.getElementById('rules-toolbar');
    const blockSelect = document.getElementById('rules-block');
    const fontSelect = document.getElementById('rules-font');
    const sizeSelect = document.getElementById('rules-size');
    const colorInput = document.getElementById('rules-color');
    const colorCustom = document.getElementById('rules-color-custom');
    const btnEdit = document.getElementById('rules-btn-edit');
    const btnSave = document.getElementById('rules-btn-save');
    const btnClose = document.getElementById('rules-btn-close');

    const adminBlock = document.getElementById('rules-admin-broadcast');
    const broadcastEditor = document.getElementById('broadcast-editor');
    const btnPublish = document.getElementById('broadcast-publish');
    const backendHint = document.getElementById('rules-backend-hint');

    const priv = isPrivilegedUser(currentUser);
    const backend = isBackendAuthConfigured();

    /** @type {Range|null} */
    let lastRange = null;
    /** @type {string} */
    let editInitialHtml = '';

    const saveSelection = () => {
        const root = editor;
        if (!(root instanceof HTMLElement)) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const r = sel.getRangeAt(0);
        if (root.contains(r.startContainer) && root.contains(r.endContainer)) {
            lastRange = r.cloneRange();
        }
    };

    const restoreSelection = () => {
        const root = editor;
        if (!(root instanceof HTMLElement)) return;
        root.focus();
        const sel = window.getSelection();
        if (!sel) return;
        if (lastRange) {
            sel.removeAllRanges();
            sel.addRange(lastRange);
            return;
        }
        // fallback: curseur à la fin
        const r = document.createRange();
        r.selectNodeContents(root);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
    };

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
            try {
                const remote = await fetchOrganRulesRemote();
                if (remote !== null && remote !== '') text = remote;
            } catch {
                showToast("Impossible de charger les règles distantes. Affichage de la version locale.", 'info');
            }
        }
        // Si la table Supabase est initialisée vide, on affiche un texte par défaut (local).
        if (backend && (!text || String(text).trim() === '')) {
            text = getRulesText();
        }
        if (!modalRules || !view) {
            const fallback = ensureFallbackRulesModal();
            const fallbackView = fallback?.querySelector?.('#rules-fallback-view');
            if (fallbackView) {
                const raw = String(text ?? '');
                fallbackView.innerHTML = looksLikeHtml(raw) ? sanitizeRulesHtml(raw) : plainTextToSafeHtml(raw);
            }
            fallback?.showModal?.();
            return;
        }
        renderRulesView(text);
        if (editor) {
            const raw = String(text ?? '');
            editor.innerHTML = looksLikeHtml(raw) ? sanitizeRulesHtml(raw) : plainTextToSafeHtml(raw);
        }
        editWrap?.classList.add('hidden');
        view?.classList.remove('hidden');
        btnSave?.classList.add('hidden');
        btnEdit?.classList.toggle('hidden', !priv);
        modalRules?.showModal();
    });

    btnClose?.addEventListener('click', async () => {
        const isEditing = !!editWrap && !editWrap.classList.contains('hidden');
        if (isEditing) {
            const current = editor?.innerHTML ?? '';
            const dirty = String(current) !== String(editInitialHtml);
            if (dirty) {
                const ok = confirm('Fermer sans enregistrer les modifications ?');
                if (!ok) return;
            }
        }
        modalRules?.close();
    });

    btnEdit?.addEventListener('click', async () => {
        let text = getRulesText();
        if (backend) {
            const r = await fetchOrganRulesRemote();
            if (r !== null) text = r;
        }
        if (backend && (!text || String(text).trim() === '')) {
            text = getRulesText();
        }
        if (editor) {
            const raw = String(text ?? '');
            editor.innerHTML = looksLikeHtml(raw) ? sanitizeRulesHtml(raw) : plainTextToSafeHtml(raw);
        }
        view?.classList.add('hidden');
        editWrap?.classList.remove('hidden');
        btnEdit?.classList.add('hidden');
        btnSave?.classList.remove('hidden');
        editInitialHtml = editor?.innerHTML ?? '';
        editor?.focus();
        saveSelection();
    });

    function exec(cmd, value) {
        restoreSelection();
        try {
            document.execCommand(cmd, false, value);
        } catch {
            /* ignore */
        }
        saveSelection();
    }

    // Éviter que la toolbar vole le focus/selection (sinon bold/underline ne s’appliquent pas).
    toolbar?.addEventListener('mousedown', (e) => {
        if (e.target?.closest?.('button[data-cmd]')) e.preventDefault();
    });

    editor?.addEventListener?.('keyup', saveSelection);
    editor?.addEventListener?.('mouseup', saveSelection);
    document.addEventListener('selectionchange', saveSelection);

    // Meilleure compat CSS pour couleur / tailles dans certains navigateurs.
    try {
        document.execCommand('styleWithCSS', false, true);
    } catch {
        /* ignore */
    }

    toolbar?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button[data-cmd]');
        if (!btn) return;
        const cmd = btn.getAttribute('data-cmd');
        if (!cmd) return;
        if (cmd === 'createLink') {
            const href = prompt('Adresse du lien (https://… ou mailto:…):');
            if (!href) return;
            exec('createLink', href);
            return;
        }
        exec(cmd);
    });

    blockSelect?.addEventListener('change', () => {
        const v = String(blockSelect.value || 'p');
        const tag = v === 'blockquote' ? 'blockquote' : v;
        exec('formatBlock', `<${tag}>`);
    });

    fontSelect?.addEventListener('change', () => {
        const v = String(fontSelect.value || 'inherit');
        if (v === 'inherit') {
            // fallback : pas de « reset » fiable via execCommand, on nettoie le formatage.
            exec('removeFormat');
            return;
        }
        exec('fontName', v);
    });

    sizeSelect?.addEventListener('change', () => {
        const px = Number.parseInt(String(sizeSelect.value || '14'), 10);
        if (!Number.isFinite(px)) return;
        // execCommand fontSize ne gère que 1..7. On l’utilise puis on remplace par px.
        exec('fontSize', '3');
        // Remapper <font size="3"> vers style font-size:px
        const root = editor;
        if (!root) return;
        const fonts = root.querySelectorAll('font[size="3"]');
        for (const f of fonts) {
            f.removeAttribute('size');
            f.style.fontSize = `${px}px`;
        }
    });

    const applyColor = (v) => {
        const c = String(v || '').trim();
        if (!c) return;
        exec('foreColor', c);
    };

    colorInput?.addEventListener('change', () => {
        const v = String(colorInput.value || '').trim();
        if (v === '__custom__') {
            colorCustom?.classList.remove('hidden');
            colorCustom?.focus();
            return;
        }
        colorCustom?.classList.add('hidden');
        applyColor(v);
    });
    colorCustom?.addEventListener('input', () => applyColor(colorCustom.value));

    btnSave?.addEventListener('click', async () => {
        const root = editor;
        if (root instanceof HTMLElement) {
            // Normalise les <font face|color|size> générés par execCommand vers des styles (sinon on perd à la sauvegarde).
            const sizeMap = { '1': '10px', '2': '12px', '3': '14px', '4': '16px', '5': '18px', '6': '24px', '7': '32px' };
            for (const f of Array.from(root.querySelectorAll('font'))) {
                const span = document.createElement('span');
                const face = f.getAttribute('face');
                const color = f.getAttribute('color');
                const size = f.getAttribute('size');
                if (face) span.style.fontFamily = face;
                if (color) span.style.color = color;
                if (size && sizeMap[size]) span.style.fontSize = sizeMap[size];
                span.innerHTML = f.innerHTML;
                f.replaceWith(span);
            }
        }
        const html = editor?.innerHTML ?? '';
        const t = sanitizeRulesHtml(html);
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
        renderRulesView(t);
        editInitialHtml = editor?.innerHTML ?? '';
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
        if (!['eleve', 'prof', 'consultation'].includes(currentUser.role)) return;
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
