/**
 * Option d’affichage : masquer le dimanche sur la vue semaine si aucun créneau « à nous »
 * (prof/admin : créneaux dont nous sommes propriétaires ; élève : tout créneau hors fermeture).
 * La réservation du dimanche reste possible (navigation / autre vue / jour courant).
 * @param {import('@fullcalendar/core').CalendarApi} calendar
 * @param {{ id?: string, email?: string, role?: string } | null} currentUser
 */
export function updatePlanningSundayColumnVisibility(calendar, currentUser) {
    if (!calendar) return;
    const view = calendar.view;
    if (!view || view.type !== 'timeGridWeek') {
        const cur = calendar.getOption('hiddenDays');
        if (Array.isArray(cur) && cur.length) calendar.setOption('hiddenDays', []);
        return;
    }

    const events = calendar.getEvents();
    const role = String(currentUser?.role || '').toLowerCase();

    const isFermeture = (ev) => {
        const db = String(ev.extendedProps?.planningDbSlotType || '').trim().toLowerCase();
        const t = String(ev.extendedProps?.type || '').trim().toLowerCase();
        return db === 'fermeture' || t === 'fermeture';
    };

    const touchesSundayLocal = (ev) => {
        const s = ev.start;
        const e = ev.end;
        if (!(s instanceof Date) || !(e instanceof Date)) return false;
        const d = new Date(s.getFullYear(), s.getMonth(), s.getDate());
        const endD = new Date(e.getFullYear(), e.getMonth(), e.getDate());
        while (d.getTime() <= endD.getTime()) {
            if (d.getDay() === 0) return true;
            d.setDate(d.getDate() + 1);
        }
        return false;
    };

    const isMine = (ev) => {
        const myId = String(currentUser?.id || '').trim();
        const myEm = String(currentUser?.email || '').trim().toLowerCase();
        const oid = String(ev.extendedProps?.ownerUserId || '').trim();
        const oem = String(ev.extendedProps?.owner || '').trim().toLowerCase();
        return (myId && oid === myId) || (myEm && oem === myEm);
    };

    let showSunday = false;
    for (const ev of events) {
        if (isFermeture(ev)) continue;
        if (!touchesSundayLocal(ev)) continue;
        if (role === 'eleve') {
            showSunday = true;
            break;
        }
        if ((role === 'prof' || role === 'admin') && isMine(ev)) {
            showSunday = true;
            break;
        }
    }

    const want = showSunday ? [] : [0];
    const cur = calendar.getOption('hiddenDays');
    const same =
        Array.isArray(cur) &&
        cur.length === want.length &&
        cur.every((v, i) => v === want[i]);
    if (!same) calendar.setOption('hiddenDays', want);
}
