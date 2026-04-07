/**
 * Règles d’utilisation et annonces (stockage local, démo — à remplacer par Apps Script).
 */

const KEY_RULES = 'orgue_iams_rules';
const KEY_BROADCAST = 'orgue_iams_broadcast';
const KEY_BROADCAST_SEEN = 'orgue_iams_broadcast_seen';

const DEFAULT_RULES = `Règles d’utilisation de l’orgue — Orgue Gérard Bancells (IAMS)

• Respecter les créneaux réservés et la signalétique sur place.
• Ne pas toucher aux jeux, à l’électronique ou à la mécanique sans accord du professeur.
• Arriver à l’heure ; en cas d’empêchement, libérer ou modifier votre réservation.
• Signaler tout incident ou anomalie au responsable.`;

export function getRulesText() {
    try {
        return localStorage.getItem(KEY_RULES) || DEFAULT_RULES;
    } catch {
        return '';
    }
}

export function setRulesText(text) {
    localStorage.setItem(KEY_RULES, text);
}

export function getBroadcast() {
    try {
        const raw = localStorage.getItem(KEY_BROADCAST);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || typeof o.text !== 'string') return null;
        return o;
    } catch {
        return null;
    }
}

/** Publie une nouvelle annonce : nouvel id → tous les élèves/profs la verront à nouveau. */
export function publishBroadcast(text) {
    const t = String(text || '').trim();
    if (!t) {
        localStorage.removeItem(KEY_BROADCAST);
        return null;
    }
    const payload = {
        id: `b_${Date.now()}`,
        text: t,
        at: new Date().toISOString()
    };
    localStorage.setItem(KEY_BROADCAST, JSON.stringify(payload));
    return payload;
}

export function getLastSeenBroadcastId() {
    try {
        return localStorage.getItem(KEY_BROADCAST_SEEN) || '';
    } catch {
        return '';
    }
}

export function markBroadcastSeen(id) {
    if (id) localStorage.setItem(KEY_BROADCAST_SEEN, id);
}

/** Popup réservée aux élèves et profs (pas à l’admin qui diffuse). */
export function shouldShowBroadcast(user) {
    if (!user || user.role === 'admin') return false;
    if (user.role !== 'eleve' && user.role !== 'prof' && user.role !== 'consultation') return false;
    const b = getBroadcast();
    if (!b || !b.text) return false;
    return b.id !== getLastSeenBroadcastId();
}
