/**
 * Sous-menu Aide dans le tiroir principal.
 */
import { APP_VERSION } from '../config/app-version.js';
import { getOrganSchoolSettingsCached, fetchOrganSchoolSettings } from './organ-settings.js';
import { closePlanningDrawer } from './planning-drawer-ui.js';
import { getPlanningSessionUser } from './session-user.js';
import { sendPlanningSupportEmail } from './slot-notify-api.js';
import { showToast } from '../utils/toast.js';

let bound = false;

function supportEmail() {
    const s = getOrganSchoolSettingsCached();
    return String(s?.planning_error_notify_email ?? '').trim();
}

function setDrawerHelpView(active) {
    document.getElementById('planning-app-drawer')?.classList.toggle('planning-app-drawer--help-view', active);
}

function showHelpPanel() {
    document.getElementById('planning-drawer-main-scroll')?.classList.add('hidden');
    const help = document.getElementById('planning-drawer-help-panel');
    help?.classList.remove('hidden');
    help?.setAttribute('aria-hidden', 'false');
    setDrawerHelpView(true);
}

export function showMainDrawerPanel() {
    document.getElementById('planning-drawer-help-panel')?.classList.add('hidden');
    document.getElementById('planning-drawer-help-panel')?.setAttribute('aria-hidden', 'true');
    document.getElementById('planning-drawer-main-scroll')?.classList.remove('hidden');
    setDrawerHelpView(false);
}

function refreshHelpContent() {
    const ver = document.getElementById('drawer-help-version');
    if (ver) ver.textContent = APP_VERSION;
}

function helpMessagePlain(ed) {
    if (!(ed instanceof HTMLElement)) return '';
    return (ed.innerText || ed.textContent || '').trim();
}

function helpMessageHtml(ed) {
    if (!(ed instanceof HTMLElement)) return '';
    const clone = ed.cloneNode(true);
    clone.querySelectorAll('script,style').forEach((n) => n.remove());
    const html = clone.innerHTML.trim();
    const plain = helpMessagePlain(ed);
    if (!plain && !html.replace(/<br\s*\/?>/gi, '').trim()) return '';
    return html || plain.replace(/\n/g, '<br/>');
}

/** @returns {Promise<Array<{ name: string, contentBase64: string }>>} */
async function readHelpAttachments() {
    const input = document.getElementById('drawer-help-attachments');
    if (!(input instanceof HTMLInputElement) || !input.files?.length) return [];
    const out = [];
    const max = Math.min(input.files.length, 5);
    for (let i = 0; i < max; i++) {
        const f = input.files[i];
        if (!f || f.size > 4_500_000) continue;
        const buf = await f.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        out.push({ name: f.name || `piece-${i + 1}`, contentBase64: b64 });
    }
    return out;
}

function clearHelpForm() {
    const subj = document.getElementById('drawer-help-subject');
    const msg = document.getElementById('drawer-help-message');
    const files = document.getElementById('drawer-help-attachments');
    if (subj instanceof HTMLInputElement) subj.value = '';
    if (msg instanceof HTMLElement) msg.innerHTML = '';
    if (files instanceof HTMLInputElement) files.value = '';
}

export function initDrawerHelpUi() {
    if (bound) return;
    bound = true;

    const msgEd = document.getElementById('drawer-help-message');
    if (msgEd instanceof HTMLElement) {
        msgEd.addEventListener('paste', (ev) => {
            const items = ev.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    ev.preventDefault();
                    const file = item.getAsFile();
                    if (!file) continue;
                    const reader = new FileReader();
                    reader.onload = () => {
                        const img = document.createElement('img');
                        img.src = String(reader.result || '');
                        img.alt = 'Image collée';
                        img.className = 'max-w-full h-auto rounded my-1';
                        msgEd.appendChild(img);
                    };
                    reader.readAsDataURL(file);
                    return;
                }
            }
        });
    }

    document.getElementById('menu-item-help')?.addEventListener('click', (e) => {
        e.preventDefault();
        void (async () => {
            await fetchOrganSchoolSettings();
            refreshHelpContent();
            showHelpPanel();
        })();
    });

    document.getElementById('drawer-help-back')?.addEventListener('click', (e) => {
        e.preventDefault();
        showMainDrawerPanel();
    });

    document.getElementById('drawer-help-contact-form')?.addEventListener('submit', (ev) => {
        ev.preventDefault();
        void (async () => {
            const mail = supportEmail();
            if (!mail) {
                showToast('E-mail support non configuré.', 'error');
                return;
            }
            const u = getPlanningSessionUser();
            const actorEmail = String(u?.email || '').trim().toLowerCase();
            if (!actorEmail) {
                showToast('Connectez-vous pour envoyer un message.', 'error');
                return;
            }
            const subj = document.getElementById('drawer-help-subject');
            const msgEl = document.getElementById('drawer-help-message');
            const subject = subj instanceof HTMLInputElement ? subj.value.trim() : '';
            const message = helpMessagePlain(msgEl);
            const messageHtml = helpMessageHtml(msgEl);
            if (!message && !messageHtml.replace(/<[^>]+>/g, '').trim()) {
                showToast('Saisissez un message.', 'error');
                return;
            }
            const attachments = await readHelpAttachments();
            const res = await sendPlanningSupportEmail({
                targetEmail: mail,
                subject: subject || 'Demande support',
                message: message || '(voir contenu HTML)',
                messageHtml,
                attachments,
                actorEmail,
                actorDisplayName: String(u?.name || u?.email || '').trim() || actorEmail
            });
            if (!res.ok || res.emailSent === false) {
                showToast(res.error || 'Envoi impossible.', 'error', 10000);
                return;
            }
            showToast('Message envoyé au support.');
            clearHelpForm();
            showMainDrawerPanel();
            closePlanningDrawer();
        })();
    });
}

export function resetDrawerHelpUiBindings() {
    bound = false;
    showMainDrawerPanel();
}
