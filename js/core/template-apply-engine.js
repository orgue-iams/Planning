/**
 * Analyse et application du gabarit semaines A/B → Google (V1).
 * TODO: e-mail récapitulatif par élève après application (hors V1).
 */
import { getAccessToken } from './auth-logic.js';
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { bridgeListEvents, bridgeDeleteEvent, bridgeUpsertEvents } from './calendar-bridge.js';
import { mondayOfLocalWeek } from './week-cycle.js';

const APPLY_RETRIES = 3;

/** @param {Date} today */
export function nextMondayStrictlyAfter(today = new Date()) {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    const dow = d.getDay();
    const add = dow === 0 ? 1 : dow === 1 ? 7 : 8 - dow;
    d.setDate(d.getDate() + add);
    return d;
}

/** 1=lundi … 7=dimanche */
export function jsGetDayMatchesTemplateDow(d, templateDow) {
    const want = templateDow === 7 ? 0 : templateDow;
    return d.getDay() === want;
}

/**
 * Alternance lundi → lundi : la semaine calendaire qui contient `periodStartYmd`
 * (repérée par son lundi local) porte `letterForWeekContainingStart`, puis A/B alterne.
 *
 * @param {Date} d
 * @param {string} periodStartYmd YYYY-MM-DD (n’importe quel jour de la semaine de référence)
 * @param {'A'|'B'} letterForWeekContainingStart
 * @returns {'A'|'B'|null}
 */
export function weekTypeLetterForAlternance(d, periodStartYmd, letterForWeekContainingStart) {
    const ymd = String(periodStartYmd || '').slice(0, 10);
    const start = new Date(`${ymd}T12:00:00`);
    if (Number.isNaN(start.getTime()) || !d || Number.isNaN(d.getTime())) return null;
    if (letterForWeekContainingStart !== 'A' && letterForWeekContainingStart !== 'B') return null;
    const refMon = mondayOfLocalWeek(start);
    const dMon = mondayOfLocalWeek(d);
    const diff = Math.round((dMon.getTime() - refMon.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (!Number.isFinite(diff)) return null;
    const flip = diff % 2 !== 0;
    let letter = letterForWeekContainingStart;
    if (flip) letter = letter === 'A' ? 'B' : 'A';
    return letter;
}

function combineDateAndTimeLocal(d, timeStr) {
    const parts = String(timeStr || '00:00:00').split(':');
    const hh = parseInt(parts[0], 10) || 0;
    const mm = parseInt(parts[1], 10) || 0;
    const ss = parseInt(parts[2], 10) || 0;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, ss, 0);
}

function eachCalendarDay(start, end) {
    const out = [];
    const cur = new Date(start);
    cur.setHours(0, 0, 0, 0);
    const last = new Date(end);
    last.setHours(0, 0, 0, 0);
    while (cur.getTime() <= last.getTime()) {
        out.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

function normEmail(s) {
    return String(s || '')
        .trim()
        .toLowerCase();
}

/** Message lisible quand la liste d’événements Google échoue (souvent 404 / droits SA). */
export function humanizeGoogleCalendarListError(raw) {
    const m = String(raw || '').trim();
    if (!m) return 'Impossible de lire le planning général sur Google Calendar.';
    if (/not found/i.test(m)) {
        return [
            'Google Calendar indique « Not Found » pour ce calendrier.',
            '',
            'Contrôlez :',
            '• planning.config.js → mainGoogleCalendarId = l’ID du calendrier « général » (souvent son adresse e-mail, ex. orgue.iams@google.com).',
            '• Supabase → secrets de calendar-bridge : GOOGLE_CALENDAR_ID doit être la même valeur.',
            '• Le calendrier est partagé avec l’e-mail du compte de service (client_email du JSON GOOGLE_SERVICE_ACCOUNT_JSON), droits de modification.',
            '• Évitez un ID déjà encodé en %40 dans les secrets (risque de double encodage).'
        ].join('\n');
    }
    if (/401|403|unauthorized|forbidden/i.test(m)) {
        return `${m}\n\nVérifiez les secrets Google côté Edge Function (compte de service ou refresh token) et les droits sur le calendrier.`;
    }
    return m;
}

/**
 * @param {object} p
 * @param {string} p.profUserId
 * @param {string} p.profEmail
 * @param {string} p.applyStartYmd — début de période (inclus)
 * @param {string} p.applyEndYmd — fin de période (inclus)
 * @param {'A'|'B'} p.firstWeekLetter — type de la semaine calendaire qui contient applyStartYmd
 * @param {object[]} p.lines — { id, week_type, day_of_week, start_time, end_time, slot_type, title, students: string[] emails }
 * @param {string} p.mainCalendarId
 */
export async function analyzeTemplateApply(p) {
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'Session expirée.' };

    const profEmail = normEmail(p.profEmail);
    const startD = new Date(`${p.applyStartYmd}T12:00:00`);
    const endD = new Date(`${p.applyEndYmd}T12:00:00`);
    const timeMax = new Date(endD);
    timeMax.setHours(23, 59, 59, 999);

    /** @type {{ start: Date, end: Date, line: object, studentEmail: string }[]} */
    const slotsWithStudent = [];

    const days = eachCalendarDay(startD, endD);
    for (const d of days) {
        const letter = weekTypeLetterForAlternance(d, p.applyStartYmd, p.firstWeekLetter);
        if (!letter) continue;
        for (const line of p.lines) {
            if (line.week_type !== letter) continue;
            if (!jsGetDayMatchesTemplateDow(d, line.day_of_week)) continue;
            const st = combineDateAndTimeLocal(d, line.start_time);
            const en = combineDateAndTimeLocal(d, line.end_time);
            if (line.slot_type === 'cours') {
                const studs = Array.isArray(line.students) ? line.students : [];
                for (const em of studs) {
                    const ne = normEmail(em);
                    if (ne) slotsWithStudent.push({ start: st, end: en, line, studentEmail: ne });
                }
            } else if (line.slot_type === 'reservation') {
                slotsWithStudent.push({
                    start: st,
                    end: en,
                    line,
                    studentEmail: '__travail__'
                });
            }
        }
    }

    const travailSlots = slotsWithStudent.filter((s) => s.studentEmail === '__travail__');
    const coursSlots = slotsWithStudent.filter((s) => s.studentEmail !== '__travail__');

    const timeMinIso = new Date(`${p.applyStartYmd}T00:00:00`).toISOString();
    const timeMaxIso = timeMax.toISOString();

    const listMain = await bridgeListEvents(token, {
        timeMin: timeMinIso,
        timeMax: timeMaxIso,
        calendarId: p.mainCalendarId
    });
    if (listMain.skipped) return { ok: false, error: 'Pont Google (calendar-bridge) non configuré.' };
    if (!listMain.ok) {
        return {
            ok: false,
            error: humanizeGoogleCalendarListError(listMain.error || 'Liste agenda général impossible.')
        };
    }
    const mainEvents = listMain.data?.events || [];

    let skippedOtherProf = 0;
    const mainCreates = [];

    for (const slot of coursSlots) {
        let blocked = false;
        for (const ev of mainEvents) {
            const xp = ev.extendedProps || {};
            const own = normEmail(xp.owner);
            const typ = String(xp.type || '').toLowerCase();
            const es = new Date(ev.start);
            const ee = new Date(ev.end);
            if (!rangesOverlap(slot.start, slot.end, es, ee)) continue;
            if (typ === 'cours' && own && own !== profEmail) {
                blocked = true;
                break;
            }
        }
        if (blocked) {
            skippedOtherProf += 1;
            continue;
        }
        mainCreates.push(slot);
    }

    const toDeleteMain = [];
    for (const ev of mainEvents) {
        const xp = ev.extendedProps || {};
        if (String(xp.type || '').toLowerCase() !== 'cours') continue;
        if (normEmail(xp.owner) !== profEmail) continue;
        const es = new Date(ev.start);
        if (es.getTime() < new Date(timeMinIso).getTime()) continue;
        if (es.getTime() > timeMax.getTime()) continue;
        const gid = xp.googleEventId || ev.id;
        if (gid) toDeleteMain.push({ googleEventId: gid, calendarId: p.mainCalendarId });
    }

    const sb = getSupabaseClient();
    /** @type {Map<string, string>} */
    const studentCalByEmail = new Map();
    if (sb && isBackendAuthConfigured()) {
        const { data: studs } = await sb.rpc('planning_list_eleves_actifs');
        for (const row of studs || []) {
            const em = normEmail(row.email);
            const { data: calId } = await sb.rpc('planning_pool_calendar_id', { p_user_id: row.user_id });
            if (em && calId) studentCalByEmail.set(em, calId);
        }
    }

    const toDeleteStudentPersonal = [];
    for (const [, calId] of studentCalByEmail) {
        const lr = await bridgeListEvents(token, {
            timeMin: timeMinIso,
            timeMax: timeMaxIso,
            calendarId: calId
        });
        if (lr.skipped || !lr.ok) continue;
        for (const ev of lr.data?.events || []) {
            const xp = ev.extendedProps || {};
            if (String(xp.type || '').toLowerCase() !== 'cours') continue;
            if (normEmail(xp.owner) !== profEmail) continue;
            const gid = xp.googleEventId || ev.id;
            if (gid) toDeleteStudentPersonal.push({ googleEventId: gid, calendarId: calId });
        }
    }

    let profPoolId = null;
    if (sb && isBackendAuthConfigured()) {
        const { data: pid } = await sb.rpc('planning_pool_calendar_id', { p_user_id: p.profUserId });
        profPoolId = pid || null;
    }

    const toDeleteProfPerso = [];
    if (profPoolId) {
        const lr = await bridgeListEvents(token, {
            timeMin: timeMinIso,
            timeMax: timeMaxIso,
            calendarId: profPoolId
        });
        if (lr.ok && !lr.skipped) {
            for (const ev of lr.data?.events || []) {
                const xp = ev.extendedProps || {};
                const own = normEmail(xp.owner);
                const typ = String(xp.type || '').toLowerCase();
                const es = new Date(ev.start);
                const ee = new Date(ev.end);
                if (es.getTime() < new Date(timeMinIso).getTime() || es.getTime() > timeMax.getTime()) continue;
                const gid = xp.googleEventId || ev.id;
                if (!gid) continue;
                if (typ === 'cours' && own === profEmail) {
                    toDeleteProfPerso.push({ googleEventId: gid, calendarId: profPoolId });
                    continue;
                }
                if (typ === 'reservation' && own === profEmail) {
                    for (const tr of travailSlots) {
                        if (rangesOverlap(tr.start, tr.end, es, ee)) {
                            toDeleteProfPerso.push({ googleEventId: gid, calendarId: profPoolId });
                            break;
                        }
                    }
                }
            }
        }
    }

    const summary = {
        deleteMainCount: toDeleteMain.length,
        deleteStudentPersoCount: toDeleteStudentPersonal.length,
        deleteProfPersoCount: toDeleteProfPerso.length,
        createMainCoursCount: mainCreates.length,
        createStudentCoursCount: mainCreates.length,
        createTravailCount: travailSlots.length,
        skippedOtherProfCount: skippedOtherProf,
        hasCoursLines: coursSlots.length > 0,
        hasTravailLines: travailSlots.length > 0
    };

    return {
        ok: true,
        plannedMainCours: mainCreates,
        plannedTravailPerso: travailSlots,
        toDeleteMain,
        toDeleteStudentPersonal,
        toDeleteProfPerso,
        profPoolId,
        studentCalByEmail,
        summary,
        timeMinIso,
        timeMaxIso
    };
}

/**
 * @param {Awaited<ReturnType<typeof analyzeTemplateApply>>} analysis
 * @param {{ profEmail: string, mainCalendarId: string }} ctx
 */
export async function executeTemplateApply(analysis, ctx) {
    if (!analysis?.ok) return { ok: false, error: 'Analyse invalide.' };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'Session expirée.' };
    const profEmail = normEmail(ctx.profEmail);
    const map = analysis.studentCalByEmail instanceof Map ? analysis.studentCalByEmail : new Map();

    for (let attempt = 1; attempt <= APPLY_RETRIES; attempt++) {
        try {
            for (const d of analysis.toDeleteMain) {
                const r = await bridgeDeleteEvent(token, d.googleEventId, d.calendarId);
                if (r.skipped) throw new Error('Pont agenda non configuré.');
                if (!r.ok) throw new Error(r.error || 'Suppression général');
            }
            for (const d of analysis.toDeleteStudentPersonal) {
                const r = await bridgeDeleteEvent(token, d.googleEventId, d.calendarId);
                if (r.skipped) throw new Error('Pont agenda non configuré.');
                if (!r.ok) throw new Error(r.error || 'Suppression perso élève');
            }
            for (const d of analysis.toDeleteProfPerso) {
                const r = await bridgeDeleteEvent(token, d.googleEventId, d.calendarId);
                if (r.skipped) throw new Error('Pont agenda non configuré.');
                if (!r.ok) throw new Error(r.error || 'Suppression perso prof');
            }

            const upserts = [];
            for (const slot of analysis.plannedMainCours) {
                upserts.push({
                    title: String(slot.line.title || 'Cours').trim() || 'Cours',
                    start: slot.start.toISOString(),
                    end: slot.end.toISOString(),
                    type: 'cours',
                    owner: profEmail,
                    calendarId: ctx.mainCalendarId,
                    inscrits: slot.studentEmail,
                    templateLineId: slot.line.id
                });
                const calId = map.get(slot.studentEmail);
                if (calId) {
                    upserts.push({
                        title: String(slot.line.title || 'Cours').trim() || 'Cours',
                        start: slot.start.toISOString(),
                        end: slot.end.toISOString(),
                        type: 'cours',
                        owner: profEmail,
                        calendarId: calId,
                        inscrits: slot.studentEmail,
                        templateLineId: slot.line.id
                    });
                }
            }
            for (const tr of analysis.plannedTravailPerso) {
                if (!analysis.profPoolId) continue;
                upserts.push({
                    title: String(tr.line.title || 'Travail').trim() || 'Travail personnel',
                    start: tr.start.toISOString(),
                    end: tr.end.toISOString(),
                    type: 'reservation',
                    owner: profEmail,
                    calendarId: analysis.profPoolId,
                    templateLineId: tr.line.id
                });
            }

            if (upserts.length > 0) {
                const r = await bridgeUpsertEvents(token, upserts, undefined);
                if (r.skipped) throw new Error('Pont agenda non configuré.');
                if (!r.ok) throw new Error(r.error || 'Création agenda');
            }

            return { ok: true };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt >= APPLY_RETRIES) return { ok: false, error: msg };
        }
    }
    return { ok: false, error: 'Échec après plusieurs tentatives.' };
}
