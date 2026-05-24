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
 * Flux iCal public (lecture seule). Nécessite que l’agenda soit « accessible au public » côté Google.
 */
export function googleCalendarPublicIcalUrl(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
}

/**
 * Abonnement par URL iCal (page réglages — ne préremplit plus le champ sur Google Agenda récent).
 * Conservé pour « Copier l’URL d’abonnement » et secours manuel.
 */
export function googleCalendarSubscribeByIcalUrl(calendarId) {
    const ical = googleCalendarPublicIcalUrl(calendarId);
    if (!ical) return '';
    return `https://calendar.google.com/calendar/r/settings/addbyurl?url=${encodeURIComponent(ical)}`;
}

/**
 * Abonnement avec boîte de confirmation Google (comme les pools IAMS).
 * Format : render?cid=webcal://…/ical/…/public/basic.ics
 * @see https://github.com/simonw/til/blob/main/ics/google-calendar-ics-subscribe-link.md
 */
export function googleCalendarSubscribeByWebcalRenderUrl(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    // @ laissé en clair ici : encodeURIComponent(cid) ne doit encoder qu’une fois (%40, pas %2540).
    const webcal = `webcal://calendar.google.com/calendar/ical/${id}/public/basic.ics`;
    return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
}

/**
 * cid en clair (adresse e-mail ou id groupe non encodé base64).
 */
export function googleCalendarSubscribeUrlPlainCid(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(id)}`;
}

/**
 * URL d’abonnement Google Calendar (cid = id encodé en base64).
 * Fiable pour les calendriers secondaires @group.calendar.google.com (pools IAMS).
 */
export function googleCalendarSubscribeUrl(calendarId) {
    const cid = calendarIdToSubscribeCid(calendarId);
    if (!cid) return '';
    return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(cid)}`;
}

/** @param {string} calendarId */
function isGroupGoogleCalendarId(calendarId) {
    return String(calendarId || '')
        .trim()
        .toLowerCase()
        .includes('@group.calendar.google.com');
}

/**
 * URL d’abonnement adaptée au type d’agenda :
 * - principal (adresse e-mail orgue.iams@…) → webcal + render (dialogue de confirmation) ;
 * - pool IAMS (@group.calendar.google.com) → lien cid base64 natif Google.
 */
export function googleCalendarSubscribeUrlPreferred(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    if (isGroupGoogleCalendarId(id)) {
        return googleCalendarSubscribeUrl(id);
    }
    return (
        googleCalendarSubscribeByWebcalRenderUrl(id) ||
        googleCalendarSubscribeUrlPlainCid(id) ||
        googleCalendarSubscribeUrl(id)
    );
}

/** URL iCal publique à coller manuellement si le lien automatique échoue. */
export function googleCalendarSubscribeCopyUrl(calendarId) {
    return googleCalendarPublicIcalUrl(calendarId);
}

export function googleCalendarEmbedUrl(calendarId, opts) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    const tz = String(opts?.timeZone ?? 'Europe/Paris').trim() || 'Europe/Paris';
    const src = encodeURIComponent(id);
    const ctz = encodeURIComponent(tz);
    return `https://calendar.google.com/calendar/embed?src=${src}&ctz=${ctz}`;
}
