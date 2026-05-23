/**
 * URL d’intégration Google Calendar pour un ID stocké en base (ex. xxx@group.calendar.google.com).
 * L’app ne stocke pas l’URL : elle la dérive à l’affichage (ex. modale Profil).
 * @param {string} calendarId
 * @param {{ timeZone?: string }} [opts] — défaut Europe/Paris (aligné agenda IAMS)
 */
/** @param {string} calendarId */
function calendarIdToSubscribeCid(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    try {
        const bytes = new TextEncoder().encode(id);
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
    } catch {
        return btoa(id);
    }
}

/**
 * URL d’abonnement Google Calendar (cid = id d’agenda encodé en base64, format attendu par Google).
 * Le libellé affiché dans Google Agenda vient du calendrier partagé ; renommable après ajout.
 */
export function googleCalendarSubscribeUrl(calendarId) {
    const cid = calendarIdToSubscribeCid(calendarId);
    if (!cid) return '';
    return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(cid)}`;
}

export function googleCalendarEmbedUrl(calendarId, opts) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    const tz = String(opts?.timeZone ?? 'Europe/Paris').trim() || 'Europe/Paris';
    const src = encodeURIComponent(id);
    const ctz = encodeURIComponent(tz);
    return `https://calendar.google.com/calendar/embed?src=${src}&ctz=${ctz}`;
}
