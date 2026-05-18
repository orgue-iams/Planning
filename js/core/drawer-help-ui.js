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

function showHelpPanel() {
    document.getElementById('planning-drawer-main-scroll')?.classList.add('hidden');
    const help = document.getElementById('planning-drawer-help-panel');
    help?.classList.remove('hidden');
    help?.setAttribute('aria-hidden', 'false');
}

export function showMainDrawerPanel() {
    document.getElementById('planning-drawer-help-panel')?.classList.add('hidden');
    document.getElementById('planning-drawer-help-panel')?.setAttribute('aria-hidden', 'true');
    document.getElementById('planning-drawer-main-scroll')?.classList.remove('hidden');
}

function refreshHelpContent() {
    const ver = document.getElementById('drawer-help-version');
    if (ver) ver.textContent = APP_VERSION;
}

export function initDrawerHelpUi() {
    if (bound) return;
    bound = true;

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
            const body = document.getElementById('drawer-help-message');
            const subject = subj instanceof HTMLInputElement ? subj.value.trim() : '';
            const message = body instanceof HTMLTextAreaElement ? body.value.trim() : '';
            if (!message) {
                showToast('Saisissez un message.', 'error');
                return;
            }
            const res = await sendPlanningSupportEmail({
                targetEmail: mail,
                subject: subject || 'Demande support',
                message,
                actorEmail,
                actorDisplayName: String(u?.name || u?.email || '').trim() || actorEmail
            });
            if (!res.ok || res.emailSent === false) {
                showToast(res.error || 'Envoi impossible.', 'error', 10000);
                return;
            }
            showToast('Message envoyé au support.');
            if (subj instanceof HTMLInputElement) subj.value = '';
            if (body instanceof HTMLTextAreaElement) body.value = '';
        })();
    });
}

export function resetDrawerHelpUiBindings() {
    bound = false;
    showMainDrawerPanel();
}
