/**
 * Profil : agendas, cours inscrits (gabarit A/B), tiroir : prochain cours.
 */
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { getPlanningSessionUser } from './session-user.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { showToast } from '../utils/toast.js';
import {
    appendEleveGabaritCoursCard,
    formatEnrolledStudentsLineFromEmails,
    formatEnrolledStudentsLineFromIds,
    padTimeHhmm
} from '../utils/template-cours-card-ui.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';
import { getPlanningEventColorClass } from './calendar-logic.js';
import { fetchPlanningListElevesActifs } from './planning-events-db.js';
import { sortEventsByStart } from './planning-courses.js';
import { fetchPlanningEventsForFullCalendar } from './planning-events-db.js';

const AGENDA_HELP =
    'Ces liens permettent d’afficher le planning dans Google Agenda (lecture seule). Dans Google Agenda : Paramètres → Ajouter un agenda → À partir de l’URL. Collez le lien copié. Le planning complet affiche tous les créneaux ; le planning personnel n’affiche que vos réservations IAMS.';

let nextCoursRefreshGen = 0;

async function loadPoolLabelByCalendarId(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) return '';
    if (!isBackendAuthConfigured()) return id;
    const sb = getSupabaseClient();
    if (!sb) return id;
    const { data } = await sb
        .from('google_calendar_pool')
        .select('label')
        .eq('google_calendar_id', id)
        .maybeSingle();
    const label = String(data?.label ?? '').trim();
    if (label) return label;
    if (id.includes('@')) {
        return id.split('@')[0].replace(/\./g, ' ').trim() || id;
    }
    return id;
}

async function loadPersonalPoolRow(userId) {
    if (!isBackendAuthConfigured() || !userId) return { id: '', label: '' };
    const sb = getSupabaseClient();
    if (!sb) return { id: '', label: '' };
    const { data } = await sb
        .from('google_calendar_pool')
        .select('google_calendar_id,label')
        .eq('assigned_user_id', userId)
        .maybeSingle();
    return {
        id: String(data?.google_calendar_id ?? '').trim(),
        label: String(data?.label ?? '').trim()
    };
}

function setAgendaEntryName(elId, name) {
    const el = document.getElementById(elId);
    if (el) el.textContent = String(name || '').trim() || '—';
}

async function copyText(text) {
    const v = String(text || '').trim();
    if (!v) {
        showToast('Aucun lien à copier.', 'error');
        return;
    }
    try {
        await navigator.clipboard.writeText(v);
        showToast('Lien copié dans le presse-papiers.');
    } catch {
        showToast('Copie impossible.', 'error');
    }
}

function bindAgendaCopyBtn(btnId, url) {
    const btn = document.getElementById(btnId);
    if (!(btn instanceof HTMLButtonElement)) return;
    const hasUrl = Boolean(url);
    btn.classList.toggle('hidden', !hasUrl);
    btn.disabled = !hasUrl;
    btn.onclick = () => void copyText(url);
}

function showAgendaHelpAlways() {
    const help = document.getElementById('drawer-agenda-help-text');
    if (help) {
        help.textContent = AGENDA_HELP;
        help.classList.remove('hidden');
    }
}

/** @param {object | null} user */
export async function refreshDrawerAgendas(user) {
    const block = document.getElementById('profile-section-agendas');
    if (!block) return;
    if (!user?.email) {
        block.classList.add('hidden');
        return;
    }
    block.classList.remove('hidden');
    showAgendaHelpAlways();

    const { mainGoogleCalendarId, mainGoogleCalendarLabel } = getPlanningConfig();
    const mainUrl = googleCalendarEmbedUrl(mainGoogleCalendarId);
    const mainLabel =
        String(mainGoogleCalendarLabel || '').trim() ||
        (await loadPoolLabelByCalendarId(mainGoogleCalendarId));
    setAgendaEntryName('drawer-agenda-main-name', mainLabel);
    bindAgendaCopyBtn('drawer-agenda-main-btn', mainUrl);

    const { id: persId, label: persLabel } = await loadPersonalPoolRow(user.id);
    const persUrl = googleCalendarEmbedUrl(persId);

    const persWrap = document.getElementById('drawer-agenda-personal-wrap');
    const persNone = document.getElementById('drawer-agenda-personal-none');
    if (persUrl) {
        setAgendaEntryName('drawer-agenda-personal-name', persLabel || persId);
        bindAgendaCopyBtn('drawer-agenda-personal-btn', persUrl);
        persWrap?.classList.remove('hidden');
        persNone?.classList.add('hidden');
    } else {
        persWrap?.classList.add('hidden');
        persNone?.classList.remove('hidden');
    }
}

/** @param {string[]} userIds @returns {Promise<Map<string, { prenom: string, nom: string, display_name?: string }>>} */
async function loadProfilesPrenomNom(userIds) {
    const uniq = [...new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const m = new Map();
    if (!uniq.length) return m;
    const sb = getSupabaseClient();
    if (!sb) return m;
    const { data, error } = await sb.from('profiles').select('id, prenom, nom, display_name').in('id', uniq);
    if (error) {
        console.warn('[drawer-profile] profiles', error.message);
        return m;
    }
    for (const row of data || []) {
        m.set(String(row.id), {
            prenom: String(row.prenom || '').trim(),
            nom: String(row.nom || '').trim(),
            display_name: String(row.display_name || '').trim()
        });
    }
    return m;
}

/** @param {string[]} userIds @returns {Promise<Map<string, string>>} */
async function loadProfileLabelsForIds(userIds) {
    const uniq = [...new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const m = new Map();
    if (!uniq.length) return m;
    const sb = getSupabaseClient();
    if (!sb) return m;
    const { data, error } = await sb.rpc('planning_profiles_label_for_ids', { p_ids: uniq });
    if (error) {
        console.warn('[drawer-profile] planning_profiles_label_for_ids', error.message);
        return m;
    }
    for (const row of data || []) {
        const id = String(row.user_id || '').trim();
        const label = String(row.label || '').trim();
        if (id && label) m.set(id, label);
    }
    return m;
}

function elevesActifsByUserId(rows) {
    const m = new Map();
    for (const r of rows || []) {
        const id = String(r.user_id || '').trim();
        if (!id) continue;
        m.set(id, r);
    }
    return m;
}

function padTimeHhmmFromDate(d) {
    if (!d || Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** @param {object} ev @param {object} line gabarit @param {{ studentEmail?: string }} [ctx] */
function eventMatchesTemplateLine(ev, line, ctx = {}) {
    const lineId = String(line.id || '').trim();
    const tpl = String(ev?.extendedProps?.planningSourceTemplateLineId || '').trim();
    if (tpl && lineId) {
        if (tpl === lineId) return true;
        return false;
    }

    const studentEmail = String(ctx.studentEmail || '')
        .trim()
        .toLowerCase();
    if (studentEmail) {
        const onEvent = inscritEmailsFromEvent(ev);
        if (!onEvent.includes(studentEmail)) return false;
    }

    const ownerId = String(ev?.extendedProps?.ownerUserId || '').trim();
    const lineOwner = String(line.owner_user_id || '').trim();
    if (lineOwner && ownerId && ownerId !== lineOwner) return false;

    const start = ev?.start instanceof Date ? ev.start : new Date(String(ev?.start ?? ''));
    if (Number.isNaN(start.getTime())) return false;

    const lineDow = Number(line.day_of_week) || 0;
    if (lineDow >= 1 && lineDow <= 7 && jsDateToPlanningDow(start) !== lineDow) return false;

    const lineT = padTimeHhmm(line.start_time);
    const evT = padTimeHhmmFromDate(start);
    if (lineT && evT && lineT !== evT) return false;

    // Prochaine occurrence réelle : pas de filtre semaine type gabarit (A/B alterne sur le calendrier).
    const lineTitle = String(line.title || '').trim().toLowerCase();
    const evTitle = String(ev.title || '').trim().toLowerCase();
    if (lineTitle && evTitle && lineTitle !== evTitle) return false;

    return true;
}

/**
 * @param {object[]} upcoming triés
 * @param {object} line
 * @param {{ studentEmail?: string, usedEventIds?: Set<string> }} ctx
 */
function findNextEventForTemplateLine(upcoming, line, ctx = {}) {
    const used = ctx.usedEventIds;
    return (
        upcoming.find((ev) => {
            const id = String(ev?.id || '').trim();
            if (used && id && used.has(id)) return false;
            return eventMatchesTemplateLine(ev, line, ctx);
        }) || null
    );
}

function inscritEmailsFromEvent(ev) {
    const raw = ev?.extendedProps?.inscrits;
    if (Array.isArray(raw)) {
        return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }
    return String(raw || '')
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

async function loadEleveGabaritEnrollments(userId) {
    const sb = getSupabaseClient();
    if (!sb || !userId) return [];
    const { data: lines } = await sb
        .from('organ_week_template_line')
        .select('id, week_type, day_of_week, start_time, end_time, title, slot_type, owner_user_id')
        .order('week_type')
        .order('day_of_week');
    if (!lines?.length) return [];
    const lids = lines.map((l) => l.id);
    const { data: links } = await sb
        .from('organ_week_template_line_student')
        .select('line_id, student_user_id')
        .in('line_id', lids);
    const lineIds = new Set(
        (links || []).filter((l) => l.student_user_id === userId).map((l) => l.line_id)
    );
    const studentsByLine = new Map();
    for (const l of links || []) {
        if (!studentsByLine.has(l.line_id)) studentsByLine.set(l.line_id, []);
        studentsByLine.get(l.line_id).push(l.student_user_id);
    }
    const ownerIds = [...new Set(lines.map((l) => l.owner_user_id).filter(Boolean))];
    const [elevesRows, ownerProfiles, ownerLabelsRpc] = await Promise.all([
        fetchPlanningListElevesActifs(),
        loadProfilesPrenomNom(ownerIds),
        ownerIds.length
            ? sb.rpc('planning_profiles_label_for_ids', { p_ids: ownerIds })
            : Promise.resolve({ data: [] })
    ]);
    const ownerLabelById = new Map((ownerLabelsRpc.data || []).map((r) => [r.user_id, r.label]));
    const elevesById = elevesActifsByUserId(elevesRows);
    return lines
        .filter((l) => lineIds.has(l.id) && String(l.slot_type || '').toLowerCase() === 'cours')
        .map((l) => {
            const ownerProf = ownerProfiles.get(l.owner_user_id);
            const ownerPrenom = ownerProf?.prenom || '';
            const ownerNom = ownerProf?.nom || '';
            const ownerLabel =
                [ownerPrenom, ownerNom].filter(Boolean).join(' ') ||
                ownerProf?.display_name ||
                String(ownerLabelById.get(l.owner_user_id) || '').trim() ||
                '';
            return {
                ...l,
                ownerLabel,
                ownerPrenom,
                ownerNom,
                studentsLine: formatEnrolledStudentsLineFromIds(
                    studentsByLine.get(l.id) || [],
                    elevesById
                )
            };
        });
}

function renderProfileCoursList(rows, list) {
    const sorted = [...rows].sort((a, b) => {
        const da = Number(a.day_of_week) || 1;
        const db = Number(b.day_of_week) || 1;
        if (da !== db) return da - db;
        return String(a.start_time || '').localeCompare(String(b.start_time || ''));
    });
    for (const line of sorted) {
        appendEleveGabaritCoursCard(list, {
            dayOfWeek: line.day_of_week,
            startTime: line.start_time,
            endTime: line.end_time,
            title: line.title,
            slotType: line.slot_type,
            studentsLine: line.studentsLine,
            ownerLabel: line.ownerLabel,
            ownerPrenom: line.ownerPrenom,
            ownerNom: line.ownerNom,
            ownerUserId: line.owner_user_id,
            planningColorClass: 'event-cours'
        });
    }
}

function jsDateToPlanningDow(d) {
    const j = d.getDay();
    return j === 0 ? 7 : j;
}

/** @param {object | null} user */
export async function refreshProfileCoursInscrits(user) {
    const block = document.getElementById('profile-section-cours');
    const list = document.getElementById('profile-cours-list');
    const empty = document.getElementById('profile-cours-empty');
    if (!block || !list) return;

    const isEleve = String(user?.role || '').toLowerCase() === 'eleve';
    block.classList.toggle('hidden', !isEleve || !user?.email);
    if (!isEleve || !user?.email) {
        list.replaceChildren();
        return;
    }

    list.className = 'planning-drawer__next-cours profile-cours-list min-w-0';
    list.replaceChildren();
    let rows = [];
    try {
        rows = await loadEleveGabaritEnrollments(user.id);
    } catch {
        /* */
    }

    if (!rows.length) {
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');
    renderProfileCoursList(rows, list);
}

/** @param {object | null} user */
export async function refreshDrawerNextCours(user) {
    const block = document.getElementById('drawer-section-next-cours');
    const cardHost = document.getElementById('drawer-next-cours-card');
    const empty = document.getElementById('drawer-next-cours-empty');
    if (!block || !cardHost) return;

    const gen = ++nextCoursRefreshGen;
    const isEleve = String(user?.role || '').toLowerCase() === 'eleve';
    block.classList.toggle('hidden', !isEleve || !user?.email);
    cardHost.replaceChildren();
    if (!isEleve || !user?.email) return;

    let enrollments = [];
    try {
        enrollments = await loadEleveGabaritEnrollments(user.id);
    } catch {
        /* */
    }
    if (!enrollments.length) {
        if (gen !== nextCoursRefreshGen) return;
        empty?.classList.remove('hidden');
        return;
    }

    const start = new Date();
    const end = new Date(start);
    end.setDate(end.getDate() + 120);
    let upcoming = [];
    try {
        const evs = await fetchPlanningEventsForFullCalendar(start, end, user);
        const now = Date.now();
        // Gabarit + lien source_template_line_id ; pas le cache grille (évite dates manquantes).
        upcoming = sortEventsByStart(
            evs.filter((ev) => String(ev?.extendedProps?.type ?? '').toLowerCase() === 'cours')
        ).filter((ev) => {
            const t = new Date(String(ev?.start ?? '')).getTime();
            return !Number.isNaN(t) && t >= now;
        });
    } catch {
        /* */
    }

    if (gen !== nextCoursRefreshGen) return;
    empty?.classList.add('hidden');

    const usedEventIds = new Set();
    const matchCtx = {
        studentEmail: String(user.email || '')
            .trim()
            .toLowerCase()
    };

    for (const line of enrollments) {
        const nextEv = findNextEventForTemplateLine(upcoming, line, {
            ...matchCtx,
            usedEventIds
        });
        if (nextEv?.id) usedEventIds.add(String(nextEv.id));
        const ownerUserId = String(line.owner_user_id || '').trim();
        let dateSubline = 'Pas de date planifiée';
        let startTime = line.start_time;
        let endTime = line.end_time;
        let title = String(line.title || '').trim() || 'Cours';
        let colorClass = 'event-cours';

        if (nextEv) {
            const startDt = new Date(String(nextEv.start ?? ''));
            dateSubline = startDt.toLocaleDateString('fr-FR', {
                weekday: 'long',
                day: 'numeric',
                month: 'long'
            });
            startTime = startDt.toISOString();
            endTime = String(nextEv.end ?? line.end_time);
            title = String(nextEv.title || '').trim() || title;
            colorClass = getPlanningEventColorClass(nextEv, user);
        }

        appendEleveGabaritCoursCard(cardHost, {
            dayOfWeek: line.day_of_week,
            startTime,
            endTime,
            dateSubline,
            title,
            slotType: 'cours',
            studentsLine: line.studentsLine,
            ownerLabel: line.ownerLabel,
            ownerPrenom: line.ownerPrenom,
            ownerNom: line.ownerNom,
            ownerUserId,
            planningColorClass: colorClass
        });
    }
}

/** @param {object | null} user */
export async function refreshDrawerProfileExtras(user) {
    await refreshProfileCoursInscrits(user);
    await refreshDrawerNextCours(user);
    await refreshDrawerAgendas(user);
}

let bound = false;

export function initDrawerProfileExtrasUi() {
    if (bound) return;
    bound = true;

    document.addEventListener('planning-profile-saved', () => {
        const u = getPlanningSessionUser();
        void refreshDrawerAgendas(u);
    });
}

export function resetDrawerProfileExtrasBindings() {
    bound = false;
}
