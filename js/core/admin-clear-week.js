/**
 * Admin : vide la semaine ciblée — agendas Google (principal + pool assignés) par plage horaire,
 * puis lignes Postgres (sans dépendre des miroirs en base).
 */
import { showToast } from '../utils/toast.js';
import { getAccessToken, isBackendAuthConfigured } from './auth-logic.js';
import { getPlanningConfig } from './supabase-client.js';
import { deletePlanningEventRow, fetchPlanningEventRowsInRange } from './planning-events-db.js';
import { invokeCalendarBridge } from './calendar-bridge.js';
import { normalizePlanningRole } from './planning-roles.js';
import { refetchPlanningGrid } from './calendar-logic.js';
import { invalidateCalendarListCache } from './calendar-events-list-cache.js';

/**
 * Plage [start, end) pour la « semaine à vider » : vue semaine / planning = fenêtre FC ; sinon semaine civile (lun→lun) contenant la date active.
 * @param {import('@fullcalendar/core').Calendar} calendar
 * @returns {{ start: Date, endExclusive: Date }}
 */
export function getPlanningWipeWeekRange(calendar) {
    if (!calendar?.view) {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const dow = now.getDay();
        const toMon = (dow + 6) % 7;
        const monday = new Date(now);
        monday.setDate(now.getDate() - toMon);
        const endExclusive = new Date(monday);
        endExclusive.setDate(monday.getDate() + 7);
        return { start: monday, endExclusive };
    }
    const view = calendar.view;
    const type = view.type;
    if (type === 'timeGridWeek' || type === 'listWeek') {
        return {
            start: new Date(view.currentStart),
            endExclusive: new Date(view.currentEnd)
        };
    }
    const anchor = calendar.getDate();
    const d = new Date(anchor);
    d.setHours(0, 0, 0, 0);
    const dow = d.getDay();
    const toMon = (dow + 6) % 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - toMon);
    const endExclusive = new Date(monday);
    endExclusive.setDate(monday.getDate() + 7);
    return { start: monday, endExclusive };
}

function formatWeekRangeFr(start, endExclusive) {
    const endInclusive = new Date(endExclusive.getTime() - 1);
    const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    return `${start.toLocaleDateString('fr-FR', opts)} → ${endInclusive.toLocaleDateString('fr-FR', opts)}`;
}

let clearWeekInFlight = false;

/**
 * @param {() => import('@fullcalendar/core').Calendar | null} getCalendar
 * @param {() => object | null} getCurrentUser
 */
export function bindAdminClearWeekButton(getCalendar, getCurrentUser) {
    const btn = document.getElementById('btn-admin-clear-week');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
        void runAdminClearWeek(getCalendar, getCurrentUser).catch((e) => {
            console.error(e);
            showToast('Opération interrompue.', 'error');
        });
    });
}

/**
 * @param {() => import('@fullcalendar/core').Calendar | null} getCalendar
 * @param {() => object | null} getCurrentUser
 */
export async function runAdminClearWeek(getCalendar, getCurrentUser) {
    const user = getCurrentUser?.();
    if (normalizePlanningRole(user?.role) !== 'admin') {
        showToast('Réservé aux administrateurs.', 'error');
        return;
    }
    const calendar = getCalendar?.();
    if (!calendar) {
        showToast('Calendrier indisponible.', 'error');
        return;
    }
    if (!isBackendAuthConfigured()) {
        showToast('Connexion requise.', 'error');
        return;
    }
    if (clearWeekInFlight) return;

    const { start, endExclusive } = getPlanningWipeWeekRange(calendar);
    const label = formatWeekRangeFr(start, endExclusive);

    const ok = confirm(
        `Vider la période :\n${label}\n\n` +
            '• Tous les événements Google sur cette plage seront supprimés sur le calendrier principal (GOOGLE_CALENDAR_ID) et sur chaque calendrier secondaire assigné à un élève.\n' +
            '• Toutes les lignes planning correspondantes seront supprimées en base (même sans lien avec Google).\n\n' +
            'Attention : tout événement Google dans cette fenêtre horaire est concerné, pas seulement ceux issus du planning.\n\n' +
            'Confirmer ?'
    );
    if (!ok) return;

    clearWeekInFlight = true;
    const btn = document.getElementById('btn-admin-clear-week');
    if (btn instanceof HTMLButtonElement) btn.disabled = true;

    try {
        const rows = await fetchPlanningEventRowsInRange(start, endExclusive);
        const ids = [
            ...new Set(
                rows
                    .map((r) => String(r?.id ?? '').trim())
                    .filter(Boolean)
            )
        ];

        const token = await getAccessToken();
        if (!token) {
            showToast('Session expirée (reconnectez-vous).', 'error');
            return;
        }

        const timeMin = start.toISOString();
        const timeMax = endExclusive.toISOString();
        const { calendarBridgeUrl } = getPlanningConfig();
        let googleTotal = 0;
        /** @type {string[]} */
        let wipeCalendarErrors = [];
        let wipeAttemptedFail = false;

        if (calendarBridgeUrl) {
            const wipe = await invokeCalendarBridge(token, {
                action: 'adminWipeCalendarsInRange',
                timeMin,
                timeMax
            });
            if (!wipe.ok && !wipe.skipped) {
                wipeAttemptedFail = true;
                showToast(
                    `Agendas Google : ${wipe.error || 'échec'} — la base sera quand même alignée si possible.`,
                    'error'
                );
            } else if (wipe.ok && wipe.data && typeof wipe.data.deletedByCalendar === 'object') {
                for (const v of Object.values(wipe.data.deletedByCalendar)) {
                    if (typeof v === 'number') googleTotal += v;
                }
            }
            if (wipe.ok && Array.isArray(wipe.data?.errors) && wipe.data.errors.length) {
                wipeCalendarErrors = wipe.data.errors;
                console.warn('[admin-clear-week] Google partiel', wipeCalendarErrors);
            }
        }

        let removed = 0;
        for (const eventId of ids) {
            const delRow = await deletePlanningEventRow(eventId);
            if (delRow.ok) removed++;
            else showToast(delRow.error || `Suppression base impossible (${eventId}).`, 'error');
        }

        invalidateCalendarListCache();
        await refetchPlanningGrid(calendar);

        if (!calendarBridgeUrl) {
            if (removed > 0) {
                showToast(
                    `${removed} créneau(x) supprimé(s) en base. Sans calendar-bridge, Google n’est pas modifié.`,
                    'info'
                );
            } else if (ids.length === 0) {
                showToast('Aucune ligne en base sur cette période. Configurez calendar-bridge pour nettoyer Google.');
            }
        } else {
            const bits = [];
            if (googleTotal > 0) bits.push(`${googleTotal} événement(s) supprimé(s) dans Google`);
            if (removed > 0) bits.push(`${removed} créneau(x) en base`);
            let suffix = '';
            if (wipeCalendarErrors.length) suffix = ' — certains agendas Google incomplets (voir console).';
            if (bits.length > 0) {
                showToast(
                    bits.join(' · ') + suffix,
                    wipeCalendarErrors.length || wipeAttemptedFail ? 'info' : 'success'
                );
            } else if (!wipeAttemptedFail && ids.length === 0 && googleTotal === 0) {
                showToast('Rien à supprimer sur cette plage (Google et base).', 'info');
            }
        }
    } finally {
        clearWeekInFlight = false;
        if (btn instanceof HTMLButtonElement) btn.disabled = false;
    }
}
