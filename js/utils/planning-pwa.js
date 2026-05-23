import {
    clearPlanningServiceWorkerCaches,
    isPlanningServiceWorkerEnabled
} from './planning-sw-env.js';
import { showToast } from './toast.js';

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

function isIosSafariNoInstallApi() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return iOS && !('BeforeInstallPromptEvent' in window);
}

/**
 * @returns {boolean} Afficher le bouton d’installation sur la modale login.
 */
export function canOfferPlanningPwaInstall() {
    if (!isPlanningServiceWorkerEnabled()) return false;
    if (isPlanningPwaInstalled()) return false;
    if (deferredInstallPrompt) return true;
    if (isIosSafariNoInstallApi()) return false;
    return true;
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

function installFallbackHint() {
    const isMac =
        typeof navigator !== 'undefined' &&
        /Mac/i.test(navigator.platform || navigator.userAgent || '');
    const msg = isMac
        ? 'Installation : dans Chrome, menu ⋮ → « Transmettre, enregistrer et partager » → « Installer la page en tant qu’application… », ou l’icône ⊕ dans la barre d’adresse.'
        : 'Installation : menu du navigateur (⋮) → « Installer l’application » ou « Ajouter à l’écran d’accueil ».';
    showToast(msg, 'info', 14000);
}

async function onInstallButtonClick() {
    const prompt = deferredInstallPrompt;
    if (prompt) {
        try {
            await prompt.prompt();
            await prompt.userChoice;
        } catch {
            /* invite annulée */
        }
        deferredInstallPrompt = null;
        syncLoginPwaInstallButton();
        return;
    }
    installFallbackHint();
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
    window.setTimeout(() => syncLoginPwaInstallButton(), 800);
}
