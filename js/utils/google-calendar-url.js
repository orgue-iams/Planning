/**
 * URL d’intégration Google Calendar pour un ID stocké en base (ex. xxx@group.calendar.google.com).
 * L’app ne stocke pas l’URL : elle la dérive à l’affichage (ex. modale Profil).
 * @param {string} calendarId
 * @param {{ timeZone?: string }} [opts] — défaut Europe/Paris (aligné agenda IAMS)
 */
/** URL d’abonnement Google Calendar (ajout au compte Google). */
export function googleCalendarSubscribeUrl(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(id)}`;
}

export function googleCalendarEmbedUrl(calendarId, opts) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    const tz = String(opts?.timeZone ?? 'Europe/Paris').trim() || 'Europe/Paris';
    const src = encodeURIComponent(id);
    const ctz = encodeURIComponent(tz);
    return `https://calendar.google.com/calendar/embed?src=${src}&ctz=${ctz}`;
}
