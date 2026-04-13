/**
 * Analyse et application du gabarit semaines A/B → Google (V1).
 * TODO: e-mail récapitulatif par élève après application (hors V1).
 */
import { getAccessToken } from './auth-logic.js';
import { getSupabaseClient, getPlanningConfig, isBackendAuthConfigured } from './supabase-client.js';
import { bridgeListEvents, bridgeDeleteEvent, bridgeUpsertEvents } from './calendar-bridge.js';
import {
    upsertPlanningEventRow,
    replacePlanningEventEnrollment,
    fetchPlanningMirrorTargetsForDelete,
    deletePlanningEventRow,
    planningUserIdForEmail,
    fetchPlanningEventRowsInRange,
    planningDbSlotTypeToBridgeType
} from './planning-events-db.js';
import {
    mondayOfLocalWeek,
    weekTypeLetterForAlternance,
    toLocalDateFromIsoDate,
    formatLocalYmd
} from './week-cycle.js';

const APPLY_RETRIES = 3;
/** Pause entre suppressions Google (client) pour limiter les quotas. */
const GOOGLE_BG_DELETE_GAP_MS = 450;
/** Pause entre deux appels bridge d’upsert (souvent 1 événement par requête côté Edge). */
const GOOGLE_BG_UPSERT_GAP_MS = 550;

/**
 * Bilan lisible quand l’application s’arrête en cours (Google n’offre pas de transaction globale).
 * @param {{ grandDone: number; grandTotal: number; deletesDone: number; upsertsDone: number; totalDel: number; upsertTotal: number }} partial
 */
export function formatTemplateApplyPartialSummary(partial) {
    if (!partial) return '';
    const { grandDone, grandTotal, deletesDone, upsertsDone, totalDel, upsertTotal } = partial;
    return [
        '——— État partiel (Google Calendar n’a pas de « tout ou rien » sur plusieurs agendas) ———',
        `Étapes terminées avant l’erreur : ${grandDone} / ${grandTotal}.`,
        `Suppressions effectuées : ${deletesDone} (prévues au total : ${totalDel}).`,
        `Écritures envoyées (créations / mises à jour d’événements) : ${upsertsDone} (prévues : ${upsertTotal}).`,
        '',
        'Il n’y a pas de retour arrière automatique fiable. Vérifiez les agendas, puis lancez « 1. Préparer l’application » pour recalculer ce qu’il reste à faire avant un nouvel « 2. Appliquer ».'
    ].join('\n');
}

function sleepMsLocal(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function normCalKey(id) {
    return String(id || '').trim().toLowerCase();
}

/**
 * Suppressions Google : général → pool prof → autres (agendas élèves).
 * @param {{ googleEventId: string, calendarId: string }[]} tasks
 */
function sortGoogleCleanupTasks(tasks, mainCalendarId, profPoolId) {
    const m = normCalKey(mainCalendarId);
    const p = normCalKey(profPoolId);
    return [...tasks].sort((a, b) => {
        const ca = normCalKey(a.calendarId);
        const cb = normCalKey(b.calendarId);
        const tier = (c) => {
            if (m && c === m) return 0;
            if (p && c === p) return 1;
            return 2;
        };
        const d = tier(ca) - tier(cb);
        if (d !== 0) return d;
        return ca.localeCompare(cb);
    });
}

/**
 * @param {Awaited<ReturnType<typeof analyzeTemplateApply>>} analysis
 * @param {{ profEmail: string, mainCalendarId: string }} ctx
 */
function buildGoogleOnlyDeletesAndUpserts(analysis, ctx) {
    const profEmail = normEmail(ctx.profEmail);
    const map = analysis.studentCalByEmail instanceof Map ? analysis.studentCalByEmail : new Map();
    const delMain = analysis.toDeleteMain;
    const delStud = analysis.toDeleteStudentPersonal;
    const delProf = analysis.toDeleteProfPerso;
    const totalDel = delMain.length + delStud.length + delProf.length;
    /** @type {Record<string, unknown>[]} */
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
    return { delMain, delStud, delProf, upserts, totalDel, upsertTotal: upserts.length };
}

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

export { weekTypeLetterForAlternance };

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

/**
 * Événement « fermeture » qui recouvre toute la semaine locale lundi 00:00 → lundi suivant exclus.
 * (Typiquement vacances posées sur le planning général.)
 */
function eventSpansEntireLocalWeek(weekMonday, evStart, evEnd) {
    const ws = new Date(weekMonday);
    ws.setHours(0, 0, 0, 0);
    const we = new Date(ws);
    we.setDate(we.getDate() + 7);
    return evStart.getTime() <= ws.getTime() + 120_000 && evEnd.getTime() >= we.getTime() - 120_000;
}

/**
 * @param {object[]} mainEvents — liste bridge (extendedProps.type, start, end)
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @returns {Set<string>} lundis YYYY-MM-DD (locaux) = semaine entière sautée pour le gabarit
 */
function collectFullClosureMondayIsoSet(mainEvents, rangeStart, rangeEnd) {
    const ferm = [];
    for (const ev of mainEvents || []) {
        const typ = String(ev.extendedProps?.type || '').toLowerCase();
        if (typ !== 'fermeture') continue;
        const es = new Date(ev.start);
        const ee = new Date(ev.end);
        if (Number.isNaN(es.getTime()) || Number.isNaN(ee.getTime())) continue;
        ferm.push({ es, ee });
    }
    const set = new Set();
    const rs = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
    rs.setHours(0, 0, 0, 0);
    const re = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
    re.setHours(0, 0, 0, 0);
    let curMon = mondayOfLocalWeek(rs);
    const endMon = mondayOfLocalWeek(re);
    while (curMon.getTime() <= endMon.getTime()) {
        const w0 = new Date(curMon);
        w0.setHours(0, 0, 0, 0);
        if (ferm.some((f) => eventSpansEntireLocalWeek(w0, f.es, f.ee))) {
            set.add(formatLocalYmd(curMon));
        }
        curMon.setDate(curMon.getDate() + 7);
    }
    return set;
}

/**
 * Lettre A/B pour un jour, en sautant les semaines entièrement en fermeture (sans avancer l’alternance).
 */
export function templateWeekLetterForDate(d, applyStartYmd, firstWeekLetter, closureMondaySet) {
    const mon = mondayOfLocalWeek(d);
    const monIso = formatLocalYmd(mon);
    if (closureMondaySet?.has(monIso)) return null;
    const refMon = mondayOfLocalWeek(toLocalDateFromIsoDate(String(applyStartYmd).slice(0, 10)));
    const targetT = mon.getTime();
    if (targetT < refMon.getTime()) {
        return weekTypeLetterForAlternance(d, applyStartYmd, firstWeekLetter);
    }
    let parity = 0;
    const walker = new Date(refMon);
    while (walker.getTime() < targetT) {
        const wIso = formatLocalYmd(walker);
        if (!closureMondaySet?.has(wIso)) parity += 1;
        walker.setDate(walker.getDate() + 7);
    }
    let letter = firstWeekLetter;
    if (parity % 2 !== 0) letter = letter === 'A' ? 'B' : 'A';
    return letter;
}

function normEmail(s) {
    return String(s || '')
        .trim()
        .toLowerCase();
}

/**
 * Un cours gabarit avec plusieurs élèves → un seul créneau base + N inscriptions.
 * @param {{ start: Date, end: Date, line: object, studentEmail: string }[]} plannedMainCours
 */
function groupTemplatePlannedCours(plannedMainCours) {
    const m = new Map();
    for (const slot of plannedMainCours || []) {
        const lid = slot.line?.id ?? '';
        const key = `${slot.start.getTime()}_${slot.end.getTime()}_${lid}`;
        if (!m.has(key)) {
            m.set(key, {
                start: slot.start,
                end: slot.end,
                line: slot.line,
                studentEmails: []
            });
        }
        const g = m.get(key);
        const ne = normEmail(slot.studentEmail);
        if (ne && !g.studentEmails.includes(ne)) g.studentEmails.push(ne);
    }
    return Array.from(m.values());
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

/** Message utilisateur quand l’écriture Google échoue (quota / rafales). */
export function humanizeGoogleCalendarApplyError(raw) {
    const m = String(raw || '').trim();
    if (!m) return 'Écriture Google Calendar impossible.';
    if (/rate limit|quota|usageLimits|userRateLimitExceeded|rateLimitExceeded/i.test(m)) {
        return [
            'Google Calendar a temporairement limité les écritures (trop de requêtes en peu de temps).',
            '',
            'Attendez une minute puis réessayez « Appliquer ». Ne cliquez pas deux fois pendant l’envoi : l’application peut prendre du temps sur une longue période.'
        ].join('\n');
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

    const closureMondaySet = collectFullClosureMondayIsoSet(mainEvents, startD, endD);

    /** @type {{ start: Date, end: Date, line: object, studentEmail: string }[]} */
    const slotsWithStudent = [];
    const days = eachCalendarDay(startD, endD);
    for (const d of days) {
        const letter = templateWeekLetterForDate(
            d,
            p.applyStartYmd,
            p.firstWeekLetter,
            closureMondaySet
        );
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
        closureFullWeekCount: closureMondaySet.size,
        hasCoursLines: coursSlots.length > 0,
        hasTravailLines: travailSlots.length > 0
    };

    return {
        ok: true,
        profUserId: p.profUserId,
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
 * Étape 1 : uniquement Postgres (pas d’appel Google). Les miroirs à nettoyer sont collectés avant DELETE.
 * Sans session Supabase configurée, retourne `google_only` (tout passera par la synchro Google en arrière-plan).
 */
export async function executeTemplateDatabasePhase(analysis, ctx) {
    if (!analysis?.ok) return { ok: false, error: 'Analyse invalide.' };
    const profEmail = normEmail(ctx.profEmail);
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : null;
    const report = (/** @type {string} */ detail, /** @type {number} */ done, /** @type {number} */ total) => {
        onProgress?.({ phase: 'db', done, total, detail });
    };

    if (!isBackendAuthConfigured()) {
        return { ok: true, mode: 'google_only' };
    }

    const profUid =
        String(ctx.profUserId || analysis.profUserId || '').trim() ||
        (await planningUserIdForEmail(profEmail));
    if (!profUid) return { ok: false, error: 'Identifiant professeur introuvable pour la grille base.' };

    const rangeStart = new Date(analysis.timeMinIso);
    const rangeEnd = new Date(analysis.timeMaxIso);
    const dbRows = await fetchPlanningEventRowsInRange(rangeStart, rangeEnd);
    const toClearDb = dbRows.filter((r) => {
        if (normEmail(r.owner_email) !== profEmail) return false;
        const st = String(r.slot_type || '');
        return st === 'cours' || st === 'travail perso';
    });
    const groupedCours = groupTemplatePlannedCours(analysis.plannedMainCours);
    const travailList = analysis.profPoolId ? analysis.plannedTravailPerso : [];
    const delDbTotal = toClearDb.length;
    const createCount = groupedCours.length + travailList.length;
    const gtDb = delDbTotal + createCount;
    const activeGt = gtDb > 0 ? gtDb : 1;
    let grandDone = 0;

    /** @type {{ googleEventId: string, calendarId: string }[]} */
    const googleCleanupTasks = [];
    const seenCleanup = new Set();

    report('Grille Postgres : analyse des suppressions…', 0, activeGt);

    for (const row of toClearDb) {
        const canonicalId = String(row.id || '').trim();
        if (!canonicalId) continue;
        const targets = await fetchPlanningMirrorTargetsForDelete(canonicalId);
        for (const t of targets) {
            const k = `${normCalKey(t.calendarId)}|${String(t.googleEventId || '').trim()}`;
            if (!k.endsWith('|') && !seenCleanup.has(k)) {
                seenCleanup.add(k);
                googleCleanupTasks.push({
                    googleEventId: String(t.googleEventId).trim(),
                    calendarId: String(t.calendarId).trim()
                });
            }
        }
        const drow = await deletePlanningEventRow(canonicalId);
        if (!drow.ok) return { ok: false, error: drow.error || 'Suppression base' };
        grandDone += 1;
        report(`Suppression base (${grandDone}/${delDbTotal})`, grandDone, activeGt);
    }

    /** @type {Record<string, unknown>[]} */
    const bridgeDbPayloads = [];

    for (const g of groupedCours) {
        const titleC = String(g.line?.title || 'Cours').trim() || 'Cours';
        const startIso = g.start.toISOString();
        const endIso = g.end.toISOString();
        const ur = await upsertPlanningEventRow({
            id: null,
            startIso,
            endIso,
            title: titleC,
            dbSlotType: 'cours',
            ownerEmail: profEmail,
            ownerUserId: profUid
        });
        if (!ur.ok || !ur.id) return { ok: false, error: ur.error || 'Insertion cours base' };
        const userIds = [];
        const emailsLower = [];
        for (const em of g.studentEmails) {
            const uid = await planningUserIdForEmail(em);
            if (uid) userIds.push(uid);
            if (em) emailsLower.push(normEmail(em));
        }
        const enr = await replacePlanningEventEnrollment(ur.id, userIds);
        if (!enr.ok) return { ok: false, error: enr.error || 'Inscriptions cours base' };
        const emailsCsv = [...new Set(emailsLower)].filter(Boolean).join(',');
        bridgeDbPayloads.push({
            planningEventId: ur.id,
            title: titleC,
            start: startIso,
            end: endIso,
            type: planningDbSlotTypeToBridgeType('cours'),
            owner: profEmail,
            ...(emailsCsv ? { inscrits: emailsCsv } : {}),
            templateLineId: g.line?.id
        });
        grandDone += 1;
        report(`Créneau cours en base (${bridgeDbPayloads.length}/${groupedCours.length})`, grandDone, activeGt);
    }

    for (let ti = 0; ti < travailList.length; ti++) {
        const tr = travailList[ti];
        const titleT = String(tr.line?.title || 'Travail').trim() || 'Travail personnel';
        const startIso = tr.start.toISOString();
        const endIso = tr.end.toISOString();
        const ur = await upsertPlanningEventRow({
            id: null,
            startIso,
            endIso,
            title: titleT,
            dbSlotType: 'travail perso',
            ownerEmail: profEmail,
            ownerUserId: profUid
        });
        if (!ur.ok || !ur.id) return { ok: false, error: ur.error || 'Insertion travail base' };
        const enrT = await replacePlanningEventEnrollment(ur.id, []);
        if (!enrT.ok) return { ok: false, error: enrT.error || 'Inscriptions travail base' };
        bridgeDbPayloads.push({
            planningEventId: ur.id,
            title: titleT,
            start: startIso,
            end: endIso,
            type: planningDbSlotTypeToBridgeType('travail perso'),
            owner: profEmail,
            calendarId: analysis.profPoolId,
            templateLineId: tr.line?.id
        });
        grandDone += 1;
        report(`Travail perso en base (${ti + 1}/${travailList.length})`, grandDone, activeGt);
    }

    if (gtDb === 0) {
        report('Rien à modifier en base.', 1, 1);
    }

    return {
        ok: true,
        mode: 'supabase',
        googleCleanupTasks,
        bridgeDbPayloads,
        stats: { deleteTotal: delDbTotal, upsertTotal: bridgeDbPayloads.length }
    };
}

/**
 * Étape 2 (arrière-plan) : Google, lentiel — général puis pool prof puis agendas élèves pour les suppressions ;
 * upserts un par un avec pause.
 * @param {{
 *   analysis: Awaited<ReturnType<typeof analyzeTemplateApply>>,
 *   ctx: { profEmail: string, profUserId?: string, mainCalendarId: string },
 *   dbResult: { ok: true, mode: 'google_only' } | { ok: true, mode: 'supabase', googleCleanupTasks: object[], bridgeDbPayloads: object[], stats: object },
 *   onProgress?: (ev: { phase: string; done: number; total: number; detail?: string }) => void
 * }} p
 */
export async function runTemplateGoogleBackgroundSync(p) {
    const { analysis, ctx, dbResult, onProgress } = p;
    if (!dbResult || dbResult.ok !== true) {
        return { ok: false, error: 'Phase base invalide.' };
    }
    const report = (detail, done, total) => {
        onProgress?.({ phase: 'google-sync', done, total, detail: detail || '' });
    };

    const bridgeConfigured = Boolean(String(getPlanningConfig().calendarBridgeUrl || '').trim());
    if (!bridgeConfigured) {
        report('Pont Google non configuré — synchro ignorée.', 1, 1);
        return { ok: true, skipped: true, stats: { deleteTotal: 0, upsertTotal: 0 } };
    }

    for (let attempt = 1; attempt <= APPLY_RETRIES; attempt++) {
        let grandDone = 0;
        let deletesDone = 0;
        let upsertsDone = 0;
        let activeGt = 1;
        let activeTotalDel = 0;
        let activeUpsertTotal = 0;
        try {
            const token = await getAccessToken();
            if (!token) throw new Error('Session expirée.');

            if (dbResult.mode === 'supabase') {
                const cleanup = sortGoogleCleanupTasks(
                    dbResult.googleCleanupTasks,
                    ctx.mainCalendarId,
                    analysis.profPoolId || ''
                );
                const ups = dbResult.bridgeDbPayloads;
                activeTotalDel = cleanup.length;
                activeUpsertTotal = ups.length;
                const totalSteps = cleanup.length + ups.length;
                activeGt = totalSteps > 0 ? totalSteps : 1;

                report('Connexion Google…', 0, activeGt);

                for (let i = 0; i < cleanup.length; i++) {
                    const t = cleanup[i];
                    const rDel = await bridgeDeleteEvent(token, t.googleEventId, t.calendarId);
                    if (!rDel.ok && !rDel.skipped) throw new Error(rDel.error || 'Suppression Google');
                    grandDone += 1;
                    deletesDone += 1;
                    report(`Suppression Google ${i + 1}/${cleanup.length} (général → prof → élèves)`, grandDone, activeGt);
                    if (i < cleanup.length - 1 || ups.length > 0) await sleepMsLocal(GOOGLE_BG_DELETE_GAP_MS);
                }

                for (let i = 0; i < ups.length; i++) {
                    const rUp = await bridgeUpsertEvents(token, [ups[i]], undefined);
                    if (rUp.skipped) {
                        report('Pont Google indisponible — arrêt des écritures.', grandDone, activeGt);
                        return { ok: true, skipped: true, stats: { deleteTotal: deletesDone, upsertTotal: upsertsDone } };
                    }
                    if (!rUp.ok) throw new Error(rUp.error || 'Écriture Google');
                    grandDone += 1;
                    upsertsDone += 1;
                    report(`Écriture Google ${i + 1}/${ups.length}`, grandDone, activeGt);
                    if (i < ups.length - 1) await sleepMsLocal(GOOGLE_BG_UPSERT_GAP_MS);
                }

                if (totalSteps === 0) {
                    report('Aucune opération Google nécessaire.', 1, 1);
                }

                return {
                    ok: true,
                    stats: { deleteTotal: cleanup.length, upsertTotal: ups.length }
                };
            }

            /* google_only */
            const { delMain, delStud, delProf, upserts, totalDel, upsertTotal } = buildGoogleOnlyDeletesAndUpserts(
                analysis,
                ctx
            );
            const orderedDel = [...delMain, ...delStud, ...delProf];
            const totalSteps = orderedDel.length + upserts.length;
            activeGt = totalSteps > 0 ? totalSteps : 1;
            activeTotalDel = totalDel;
            activeUpsertTotal = upsertTotal;

            report('Google uniquement : suppressions (général → élèves → prof)…', 0, activeGt);

            for (let i = 0; i < orderedDel.length; i++) {
                const d = orderedDel[i];
                const rDel = await bridgeDeleteEvent(token, d.googleEventId, d.calendarId);
                if (rDel.skipped) throw new Error('Pont agenda non configuré.');
                if (!rDel.ok) throw new Error(rDel.error || 'Suppression Google');
                grandDone += 1;
                deletesDone += 1;
                report(`Suppression ${i + 1}/${orderedDel.length}`, grandDone, activeGt);
                if (i < orderedDel.length - 1 || upserts.length > 0) await sleepMsLocal(GOOGLE_BG_DELETE_GAP_MS);
            }

            for (let i = 0; i < upserts.length; i++) {
                const rUp = await bridgeUpsertEvents(token, [upserts[i]], undefined);
                if (rUp.skipped) throw new Error('Pont agenda non configuré.');
                if (!rUp.ok) throw new Error(rUp.error || 'Écriture Google');
                grandDone += 1;
                upsertsDone += 1;
                report(`Écriture ${i + 1}/${upserts.length}`, grandDone, activeGt);
                if (i < upserts.length - 1) await sleepMsLocal(GOOGLE_BG_UPSERT_GAP_MS);
            }

            if (totalSteps === 0) {
                report('Rien à modifier sur Google.', 1, 1);
            }

            return { ok: true, stats: { deleteTotal: totalDel, upsertTotal } };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const human = humanizeGoogleCalendarApplyError(msg);
            const partial =
                grandDone > 0
                    ? {
                          grandDone,
                          grandTotal: activeGt,
                          deletesDone,
                          upsertsDone,
                          totalDel: activeTotalDel,
                          upsertTotal: activeUpsertTotal
                      }
                    : undefined;
            if (partial) {
                return { ok: false, error: human, partial };
            }
            if (attempt >= APPLY_RETRIES) {
                return { ok: false, error: human };
            }
        }
    }
    return { ok: false, error: humanizeGoogleCalendarApplyError('Échec après plusieurs tentatives.') };
}
