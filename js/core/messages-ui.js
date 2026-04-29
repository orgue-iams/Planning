/**
 * Modale Consignes ; annonces planifiées via Supabase (menu Annonces / bandeau login).
 */

import { showToast } from '../utils/toast.js';
import { getRulesText, markBroadcastSeen } from '../utils/messaging.js';
import { isPrivilegedUser } from './auth-logic.js';
import { isBackendAuthConfigured } from './supabase-client.js';
import { fetchOrganRulesRemote, saveOrganRulesRemote } from '../utils/org-content.js';
import {
    formatSimpleRichHtml,
    looksLikeHtml,
    normalizeQuillMarkup,
    plainTextToSafeHtml,
    sanitizeRulesHtml
} from '../utils/rich-text.js';
import {
    createPlanningQuill,
    destroyPlanningQuillMount,
    isQuillAvailable,
    quillSetHtml
} from '../utils/planning-quill.js';
import { getPlanningSessionUser } from './session-user.js';

function renderRulesView(text) {
    const el = document.getElementById('rules-view');
    if (!el) return;
    const raw = String(text ?? '');
    const inner = looksLikeHtml(raw) ? sanitizeRulesHtml(raw) : plainTextToSafeHtml(raw);
    el.innerHTML = `<div class="organ-rich">${inner}</div>`;
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
                <h3 class="font-black text-sm uppercase tracking-wide text-slate-600 border-b pb-2 shrink-0">Consignes</h3>
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

/** @type {AbortController | null} */
let messagesUiAbort = null;

export function resetMessagesUiBindings() {
    messagesUiAbort?.abort();
    messagesUiAbort = null;
}

/** @param {unknown} [_ignored] conservé pour compat. appelants ; utiliser getPlanningSessionUser(). */
export function initMessagesUi(_ignored) {
    resetMessagesUiBindings();
    messagesUiAbort = new AbortController();
    const { signal } = messagesUiAbort;

    const btnRules =
        document.getElementById('btn-rules-trigger') ||
        document.getElementById('btn-rules') ||
        document.querySelector('#app-header #btn-rules-trigger') ||
        document.querySelector('#app-header #btn-rules');
    const modalRules = document.getElementById('modal_rules');
    const modalBroadcast = document.getElementById('modal_broadcast');

    const view = document.getElementById('rules-view');
    const editWrap = document.getElementById('rules-edit-wrap');
    const rulesMount = document.getElementById('rules-quill-mount');
    const btnEdit = document.getElementById('rules-btn-edit');
    const btnSave = document.getElementById('rules-btn-save');
    const btnClose = document.getElementById('rules-btn-close');

    const adminBlock = document.getElementById('rules-admin-broadcast');
    const broadcastEditor = document.getElementById('broadcast-editor');
    const btnPublish = document.getElementById('broadcast-publish');
    const backendHint = document.getElementById('rules-backend-hint');

    /** @type {any} */
    let rulesQuill = null;
    let editInitialHtml = '';

    const resetRulesQuill = () => {
        if (rulesMount instanceof HTMLElement) destroyPlanningQuillMount(rulesMount);
        rulesQuill = null;
    };

    const rulesEditorHtml = () => (rulesQuill ? String(rulesQuill.root.innerHTML) : '');

    const applyPrivVisibility = () => {
        const u = getPlanningSessionUser();
        const priv = isPrivilegedUser(u);
        const backend = isBackendAuthConfigured();
        if (priv) {
            btnEdit?.classList.toggle('hidden', !backend);
            adminBlock?.classList.add('hidden');
            backendHint?.classList.toggle('hidden', !backend);
        } else {
            btnEdit?.classList.add('hidden');
            adminBlock?.classList.add('hidden');
            backendHint?.classList.add('hidden');
        }
    };

    applyPrivVisibility();

    modalRules?.addEventListener(
        'close',
        () => {
            resetRulesQuill();
        },
        { signal }
    );

    btnRules?.addEventListener(
        'click',
        async () => {
            applyPrivVisibility();
            resetRulesQuill();
            let text = getRulesText();
            const backend = isBackendAuthConfigured();
            if (backend) {
                try {
                    const remote = await fetchOrganRulesRemote();
                    if (remote !== null && remote !== '') text = remote;
                } catch {
                    showToast('Impossible de charger les consignes distantes. Affichage de la version locale.', 'info');
                }
            }
            if (backend && (!text || String(text).trim() === '')) {
                text = getRulesText();
            }
            if (!modalRules || !view) {
                const fallback = ensureFallbackRulesModal();
                const fallbackView = fallback?.querySelector('#rules-fallback-view');
                if (fallbackView) {
                    const raw = String(text ?? '');
                    const inner = looksLikeHtml(raw) ? sanitizeRulesHtml(raw) : plainTextToSafeHtml(raw);
                    fallbackView.innerHTML = `<div class="organ-rich">${inner}</div>`;
                }
                fallback?.showModal();
                return;
            }
            renderRulesView(text);
            editWrap?.classList.add('hidden');
            view?.classList.remove('hidden');
            btnSave?.classList.add('hidden');
            const uOpen = getPlanningSessionUser();
            btnEdit?.classList.toggle('hidden', !isPrivilegedUser(uOpen));
            modalRules?.showModal();
        },
        { signal }
    );

    btnClose?.addEventListener(
        'click',
        async () => {
            const isEditing = !!(editWrap && !editWrap.classList.contains('hidden'));
            if (isEditing && rulesQuill) {
                const dirty = String(rulesEditorHtml()) !== String(editInitialHtml);
                if (dirty) {
                    const ok = confirm('Fermer sans enregistrer les modifications ?');
                    if (!ok) return;
                }
            }
            modalRules?.close();
        },
        { signal }
    );

    btnEdit?.addEventListener(
        'click',
        async () => {
            if (!(rulesMount instanceof HTMLElement)) return;
            if (!isQuillAvailable()) {
                showToast('Éditeur indisponible. Rechargez la page.', 'error');
                return;
            }
            resetRulesQuill();
            let text = getRulesText();
            const backend = isBackendAuthConfigured();
            if (backend) {
                const r = await fetchOrganRulesRemote();
                if (r !== null) text = r;
            }
            if (backend && (!text || String(text).trim() === '')) {
                text = getRulesText();
            }
            /* Après tout await : re-vider le mount (évite barres empilées si close / ré-init pendant le fetch). */
            resetRulesQuill();
            rulesQuill = createPlanningQuill(rulesMount, {
                placeholder: 'Saisissez les consignes…',
                adminFontStepper: getPlanningSessionUser()?.role === 'admin',
                disableFontSizeButtons: true
            });
            const raw = String(text ?? '');
            const initial = looksLikeHtml(raw)
                ? sanitizeRulesHtml(normalizeQuillMarkup(raw))
                : plainTextToSafeHtml(raw);
            quillSetHtml(rulesQuill, initial);
            editInitialHtml = rulesEditorHtml();

            view?.classList.add('hidden');
            editWrap?.classList.remove('hidden');
            btnEdit?.classList.add('hidden');
            btnSave?.classList.remove('hidden');
        },
        { signal }
    );

    btnSave?.addEventListener(
        'click',
        async () => {
            if (!rulesQuill) return;
            const html = rulesQuill.root.innerHTML;
            const t = sanitizeRulesHtml(normalizeQuillMarkup(html));
            if (!isBackendAuthConfigured()) {
                showToast('Configuration Supabase requise pour enregistrer les consignes.', 'error');
                return;
            }
            const res = await saveOrganRulesRemote(t);
            if (!res.ok) {
                showToast(res.error || 'Erreur', 'error');
                return;
            }
            resetRulesQuill();
            editWrap?.classList.add('hidden');
            view?.classList.remove('hidden');
            btnEdit?.classList.remove('hidden');
            btnSave?.classList.add('hidden');
            renderRulesView(t);
            editInitialHtml = '';
            showToast('Consignes enregistrées.');
        },
        { signal }
    );

    btnPublish?.addEventListener(
        'click',
        () => {
            showToast('Utilisez le menu Réglages (engrenage) → Annonces (Supabase) pour publier une annonce.', 'info');
        },
        { signal }
    );

    const btnBroadcastOk = document.getElementById('broadcast-btn-ok');

    btnBroadcastOk?.addEventListener(
        'click',
        () => {
            const id = modalBroadcast?.dataset.broadcastId;
            if (id) {
                if (id.startsWith('sm_')) {
                    localStorage.setItem(`orgue_sm_seen_${id.slice(3)}`, '1');
                } else {
                    markBroadcastSeen(id);
                }
            }
            modalBroadcast?.close();
        },
        { signal }
    );
}

export async function tryShowBroadcastPopup(currentUser) {
    void currentUser;
    /* Popups locales supprimées : annonces via Supabase uniquement. */
}
