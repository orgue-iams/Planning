/** Ports courants (Vite, Live Server, etc.) : pas de SW pour éviter cache-first en dev USB/local. */
const DEV_PORTS = new Set(['5173', '4173', '3000', '5500', '8080', '8888']);

/**
 * @returns {boolean} false sur localhost / IP loopback / ports dev → pas d’enregistrement SW.
 */
export function isPlanningServiceWorkerEnabled() {
    try {
        const { hostname, port, protocol } = window.location;
        if (protocol === 'file:') return false;
        const host = String(hostname || '').toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
            return false;
        }
        if (port && DEV_PORTS.has(port)) return false;
        return true;
    } catch {
        return true;
    }
}

/** Retire un SW / cache PWA laissé par une session prod ou un test sur le même navigateur. */
export async function clearPlanningServiceWorkerCaches() {
    if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter((k) => k.startsWith('orgue-v')).map((k) => caches.delete(k))
        );
    }
}
