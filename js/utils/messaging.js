/**
 * Consignes (texte local) et annonces (stockage local en démo).
 */

const KEY_RULES = 'orgue_iams_rules';
const KEY_BROADCAST = 'orgue_iams_broadcast';
const KEY_BROADCAST_SEEN = 'orgue_iams_broadcast_seen';

const DEFAULT_RULES = `Consignes

Horaires de l'ICT:
À compter du 8 septembre lundi, mardi, mercredi et vendredi de 9h à 20h45, jeudi de 9h à 21h45.

Travail personnel :
2 h par semaine / par personne. Il est possible de réserver des créneaux sur 3 semaines consécutives.

Messe à 12h40: il n'est pas possible de réserver entre 12h et 13h30

Chapelle réservée pour le chœur grégorien le mardi de 17h30 à 20h30 pour les dates suivantes: 25/11, 2/12, 20/01, 25/02, 17/03, 26/05, 23/06, 30/06`;

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
