/**
 * Sous-menu Aide dans le tiroir principal.
 */
import { CACHE_NAME } from '../config/cache-name.js';
import { getOrganSchoolSettingsCached, fetchOrganSchoolSettings } from './organ-settings.js';
import { closePlanningDrawer } from './planning-drawer-ui.js';

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
    if (ver) ver.textContent = CACHE_NAME;
    const form = document.getElementById('drawer-help-contact-form');
    const mail = supportEmail();
    if (form instanceof HTMLFormElement && mail) {
        form.action = `mailto:${mail}`;
    }
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
        const mail = supportEmail();
        if (!mail) {
            ev.preventDefault();
            return;
        }
        const subj = document.getElementById('drawer-help-subject');
        const body = document.getElementById('drawer-help-message');
        const s = subj instanceof HTMLInputElement ? encodeURIComponent(subj.value.trim()) : '';
        const b = body instanceof HTMLTextAreaElement ? encodeURIComponent(body.value.trim()) : '';
        const a = document.getElementById('drawer-help-mailto-anchor');
        if (a instanceof HTMLAnchorElement) {
            a.href = `mailto:${mail}?subject=${s}&body=${b}`;
            a.click();
        }
        ev.preventDefault();
    });
}

export function resetDrawerHelpUiBindings() {
    bound = false;
    showMainDrawerPanel();
}
