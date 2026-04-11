/**
 * Extrait l’ID brut Google Calendar (ex. xxx@group.calendar.google.com) depuis une saisie utilisateur.
 * Si on enregistre une URL d’intégration (?src=…), l’API Calendar renvoie 404 sur POST /events.
 */
export function normalizeGoogleCalendarId(raw: string): string {
    let s = String(raw ?? '').trim();
    if (!s) return '';

    if (/^https?:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            const src = u.searchParams.get('src');
            if (src?.trim()) {
                s = src.trim();
            }
        } catch {
            const m = s.match(/[?&]src=([^&]+)/i);
            if (m) {
                try {
                    s = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
                } catch {
                    s = m[1].trim();
                }
            }
        }
    } else {
        const m = s.match(/[?&]src=([^&]+)/i);
        if (m) {
            try {
                s = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
            } catch {
                s = m[1].trim();
            }
        }
    }

    try {
        if (s.includes('%') && !s.includes('://')) {
            const once = decodeURIComponent(s);
            if (once && !once.includes('%')) s = once;
        }
    } catch {
        /* */
    }

    return s.trim();
}
