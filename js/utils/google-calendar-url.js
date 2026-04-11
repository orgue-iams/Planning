/** URL d’affichage / abonnement (iframe) pour un ID Google Calendar. */
export function googleCalendarEmbedUrl(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    return `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(id)}`;
}
