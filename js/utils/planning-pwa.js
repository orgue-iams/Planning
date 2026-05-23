import {
    clearPlanningServiceWorkerCaches,
    isPlanningServiceWorkerEnabled
} from './planning-sw-env.js';

/** @type {BeforeInstallPromptEvent | null} */
let deferredInstallPrompt = null;

/** Évite un rechargement au premier contrôle SW de la session. */
let hadServiceWorkerControllerAtLoad = false;

/** @type {ServiceWorkerRegistration | null} */
let serviceWorkerRegistration = null;

/**
 * @returns {boolean} App déjà installée (standalone / iOS accueil).
 */
export function isPlanningPwaInstalled() {
    try {
        if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
        const modes = ['standalone', 'fullscreen', 'minimal-ui'];
        return modes.some((m) => window.matchMedia(`(display-mode: ${m})`).matches);
    } catch {
        return false;
    }
}

/**
 * @returns {boolean} Peut proposer l’installation native (Chrome/Edge/Android).
 */
export function canOfferPlanningPwaInstall() {
    if (!isPlanningServiceWorkerEnabled()) return false;
    if (isPlanningPwaInstalled()) return false;
    return Boolean(deferredInstallPrompt);
}

/**
 * Affiche ou masque le bouton « Installer l’application » sur la modale login.
 */
export function syncLoginPwaInstallButton() {
    const btn = document.getElementById('btn-pwa-install');
    if (!(btn instanceof HTMLButtonElement)) return;
    const show = canOfferPlanningPwaInstall();
    btn.classList.toggle('hidden', !show);
    btn.disabled = !show;
    btn.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function reloadForServiceWorkerUpdate() {
    window.location.reload();
}

function onServiceWorkerControllerChange() {
    if (!hadServiceWorkerControllerAtLoad) {
        hadServiceWorkerControllerAtLoad = true;
        return;
    }
    reloadForServiceWorkerUpdate();
}

function watchInstallingWorker(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
        if (worker.state !== 'installed' || !navigator.serviceWorker.controller) return;
        const waiting = serviceWorkerRegistration?.waiting;
        if (waiting) {
            waiting.postMessage({ type: 'SKIP_WAITING' });
        }
    });
}

function attachRegistrationUpdateListener(reg) {
    reg.addEventListener('updatefound', () => {
        watchInstallingWorker(reg.installing);
    });
    if (reg.waiting && navigator.serviceWorker.controller) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
}

async function checkForServiceWorkerUpdate() {
    if (!serviceWorkerRegistration) return;
    try {
        await serviceWorkerRegistration.update();
    } catch {
        /* hors-ligne ou erreur réseau */
    }
}

/**
 * Enregistre le SW, vérifie les mises à jour et recharge sans invite si une nouvelle version est prête.
 * @param {string | URL} swUrl
 */
export async function registerPlanningServiceWorker(swUrl) {
    if (!('serviceWorker' in navigator)) return;
    if (!isPlanningServiceWorkerEnabled()) {
        await clearPlanningServiceWorkerCaches();
        return;
    }

    hadServiceWorkerControllerAtLoad = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', onServiceWorkerControllerChange);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkForServiceWorkerUpdate();
    });

    try {
        serviceWorkerRegistration = await navigator.serviceWorker.register(swUrl, { type: 'module' });
        attachRegistrationUpdateListener(serviceWorkerRegistration);
        void checkForServiceWorkerUpdate();
    } catch {
        serviceWorkerRegistration = null;
    }
}

function bindInstallPromptEvents() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = /** @type {BeforeInstallPromptEvent} */ (e);
        syncLoginPwaInstallButton();
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        syncLoginPwaInstallButton();
    });
}

async function onInstallButtonClick() {
    const prompt = deferredInstallPrompt;
    if (!prompt) return;
    try {
        await prompt.prompt();
        await prompt.userChoice;
    } catch {
        /* invite annulée ou indisponible */
    }
    deferredInstallPrompt = null;
    syncLoginPwaInstallButton();
}

/**
 * Bouton d’installation sur la modale login (prod / SW actif uniquement).
 */
export function initPlanningPwaLoginInstallUi() {
    if (!isPlanningServiceWorkerEnabled()) return;

    bindInstallPromptEvents();

    const btn = document.getElementById('btn-pwa-install');
    btn?.addEventListener('click', (e) => {
        e.preventDefault();
        void onInstallButtonClick();
    });

    syncLoginPwaInstallButton();
}
