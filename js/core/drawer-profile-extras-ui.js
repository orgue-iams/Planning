/**
 * Profil : agendas, cours inscrits (gabarit A/B), tiroir : prochain cours.
 */
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { getPlanningSessionUser } from './session-user.js';
import {
    googleCalendarEmbedUrl,
    googleCalendarSubscribeCopyUrl,
    googleCalendarSubscribeUrlPreferred
} from '../utils/google-calendar-url.js';
import { showToast } from '../utils/toast.js';
import {
    appendEleveGabaritCoursCard,
    formatEnrolledStudentsLineFromEmails,
    formatEnrolledStudentsLineFromIds,
    padTimeHhmm
} from '../utils/template-cours-card-ui.js';
import { formatProfileFullName } from '../utils/profile-full-name.js';
import { getPlanningEventColorClass, isEleveEnrolledInCoursEvent } from './calendar-logic.js';
import { fetchPlanningListElevesActifs } from './planning-events-db.js';
import { sortEventsByStart } from './planning-courses.js';
import { fetchPlanningEventsForFullCalendar } from './planning-events-db.js';

const AGENDA_LABEL_MAIN = 'Orgue IAMS - global';
const AGENDA_LABEL_PERSONAL = 'Orgue IAMS - Mes créneaux';

const AGENDA_HELP_BASE =
    'Ajoutez chaque calendrier avec le bouton dédié (un à la fois). « Copier l’URL » sert à une intégration lecture seule dans un site.';

const AGENDA_HELP_SUBSCRIBE =
    'Global et mes créneaux : fenêtre de confirmation Google (Safari). Après ajout, cochez l’agenda dans le menu ☰ → Autres agendas — renommable ensuite. Secours global : « Copier URL abonnement ».';

const AGENDA_HELP_COLORS =
    'Couleurs : sur un agenda IAMS abonné (lecture seule), Google Agenda affiche souvent une seule couleur d’agenda (ex. violet), pas les couleurs par type comme sur votre agenda perso nicolas.marestin@… Les couleurs par type restent visibles dans l’app Planning et sur calendar.google.com pour le compte orgue.iams.';

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

/** Un seul geste utilisateur = une navigation (évite le blocage popup sur mobile). */
function openGoogleCalendarSubscribe(url, label, { isMain = false } = {}) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', `Ajouter ${label} dans Google Agenda`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    const afterAdd = isMain
        ? ' Confirmez l’ajout dans la fenêtre Google (comme pour mes créneaux), puis cochez l’agenda dans Autres agendas (menu ☰).'
        : ' Confirmez l’ajout, puis cochez « Planning IAMS … » dans Autres agendas (menu ☰).';
    showToast(`« ${label} » :${afterAdd}`, 'info', 10000);
}

function bindAgendaSubscribeBtn(btnId, url, label, opts = {}) {
    const btn = document.getElementById(btnId);
    if (!(btn instanceof HTMLButtonElement)) return;
    const hasUrl = Boolean(url);
    btn.classList.toggle('hidden', !hasUrl);
    btn.disabled = !hasUrl;
    btn.onclick = () => openGoogleCalendarSubscribe(url, label, opts);
}

function bindAgendaCopyBtn(btnId, url) {
    const btn = document.getElementById(btnId);
    if (!(btn instanceof HTMLButtonElement)) return;
    const hasUrl = Boolean(url);
    btn.classList.toggle('hidden', !hasUrl);
    btn.disabled = !hasUrl;
    btn.onclick = () => void copyText(url);
}

function buildAgendaHelpText() {
    return [AGENDA_HELP_BASE, AGENDA_HELP_SUBSCRIBE, AGENDA_HELP_COLORS].join(' ');
}

function showAgendaHelpAlways() {
    const help = document.getElementById('drawer-agenda-help-text');
    if (help) {
        help.textContent = buildAgendaHelpText();
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

    const { mainGoogleCalendarId } = getPlanningConfig();
    const mainUrl = googleCalendarEmbedUrl(mainGoogleCalendarId);
    const mainSubCopy = googleCalendarSubscribeCopyUrl(mainGoogleCalendarId);
    setAgendaEntryName('drawer-agenda-main-name', AGENDA_LABEL_MAIN);
    bindAgendaCopyBtn('drawer-agenda-main-btn', mainUrl);
    bindAgendaCopyBtn('drawer-agenda-main-subscribe-copy-btn', mainSubCopy);

    const { id: persId } = await loadPersonalPoolRow(user.id);
    const persUrl = googleCalendarEmbedUrl(persId);

    const persWrap = document.getElementById('drawer-agenda-personal-wrap');
    const persNone = document.getElementById('drawer-agenda-personal-none');
    if (persUrl) {
        setAgendaEntryName('drawer-agenda-personal-name', AGENDA_LABEL_PERSONAL);
        bindAgendaCopyBtn('drawer-agenda-personal-btn', persUrl);
        persWrap?.classList.remove('hidden');
        persNone?.classList.add('hidden');
    } else {
        persWrap?.classList.add('hidden');
        persNone?.classList.remove('hidden');
    }

    const mainSub = googleCalendarSubscribeUrlPreferred(mainGoogleCalendarId);
    const persSub = googleCalendarSubscribeUrlPreferred(persId);
    const subWrap = document.getElementById('drawer-agenda-subscribe-wrap');
    subWrap?.classList.toggle('hidden', !mainSub && !persSub);
    bindAgendaSubscribeBtn('drawer-agenda-subscribe-main-btn', mainSub, AGENDA_LABEL_MAIN, { isMain: true });
    bindAgendaSubscribeBtn('drawer-agenda-subscribe-personal-btn', persSub, AGENDA_LABEL_PERSONAL);
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
/** Créneau « cours » planifié sans lien gabarit (semaines types). */
function isExceptionalCoursPlanningEvent(ev) {
    const db = String(ev?.extendedProps?.planningDbSlotType || '').toLowerCase();
    const typ = String(ev?.extendedProps?.type || '').toLowerCase();
    if (db !== 'cours' && typ !== 'cours') return false;
    return !String(ev?.extendedProps?.planningSourceTemplateLineId || '').trim();
}

/**
 * @param {object[]} upcoming
 * @param {object} user
 * @param {Set<string>} usedEventIds
 */
function findExceptionalUpcomingCours(upcoming, user, usedEventIds) {
    return upcoming.filter((ev) => {
        const id = String(ev?.id || '').trim();
        if (id && usedEventIds.has(id)) return false;
        if (!isExceptionalCoursPlanningEvent(ev)) return false;
        return isEleveEnrolledInCoursEvent(ev, user);
    });
}

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
    const gabaritHost = document.getElementById('drawer-next-cours-gabarit');
    const exceptionalWrap = document.getElementById('drawer-next-cours-exceptional-wrap');
    const exceptionalHost = document.getElementById('drawer-next-cours-exceptional');
    const empty = document.getElementById('drawer-next-cours-empty');
    if (!block || !gabaritHost) return;

    const gen = ++nextCoursRefreshGen;
    const isEleve = String(user?.role || '').toLowerCase() === 'eleve';
    block.classList.toggle('hidden', !isEleve || !user?.email);
    gabaritHost.replaceChildren();
    exceptionalHost?.replaceChildren();
    exceptionalWrap?.classList.add('hidden');
    if (!isEleve || !user?.email) return;

    let enrollments = [];
    try {
        enrollments = await loadEleveGabaritEnrollments(user.id);
    } catch {
        /* */
    }

    const start = new Date();
    const end = new Date(start);
    end.setDate(end.getDate() + 120);
    let upcoming = [];
    try {
        const evs = await fetchPlanningEventsForFullCalendar(start, end, user);
        const now = Date.now();
        upcoming = sortEventsByStart(
            evs.filter((ev) => {
                const typ = String(ev?.extendedProps?.type ?? '').toLowerCase();
                const db = String(ev?.extendedProps?.planningDbSlotType ?? '').toLowerCase();
                return typ === 'cours' || db === 'cours';
            })
        ).filter((ev) => {
            const t = new Date(String(ev?.start ?? '')).getTime();
            return !Number.isNaN(t) && t >= now;
        });
    } catch {
        /* */
    }

    if (gen !== nextCoursRefreshGen) return;

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

        appendEleveGabaritCoursCard(gabaritHost, {
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

    const exceptional = findExceptionalUpcomingCours(upcoming, user, usedEventIds);
    if (exceptional.length && exceptionalHost) {
        exceptionalWrap?.classList.remove('hidden');
        const ownerIds = [
            ...new Set(
                exceptional
                    .map((ev) => String(ev?.extendedProps?.ownerUserId || '').trim())
                    .filter(Boolean)
            )
        ];
        const ownerProfiles = await loadProfilesPrenomNom(ownerIds);
        const ownerLabelsRpc = ownerIds.length ? await loadProfileLabelsForIds(ownerIds) : new Map();
        const elevesActifs = await fetchPlanningListElevesActifs();
        const elevesByEmail = new Map(
            elevesActifs
                .map((e) => [String(e.email || '').trim().toLowerCase(), e])
                .filter(([em]) => em)
        );
        for (const ev of exceptional) {
            const startDt = new Date(String(ev.start ?? ''));
            const ownerUserId = String(ev?.extendedProps?.ownerUserId || '').trim();
            const ownerProf = ownerProfiles.get(ownerUserId);
            const ownerPrenom = ownerProf?.prenom || '';
            const ownerNom = ownerProf?.nom || '';
            const ownerLabel =
                [ownerPrenom, ownerNom].filter(Boolean).join(' ') ||
                ownerProf?.display_name ||
                String(ownerLabelsRpc.get(ownerUserId) || '').trim() ||
                '';
            appendEleveGabaritCoursCard(exceptionalHost, {
                dayOfWeek: jsDateToPlanningDow(startDt),
                startTime: startDt.toISOString(),
                endTime: String(ev.end ?? ''),
                dateSubline: startDt.toLocaleDateString('fr-FR', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long'
                }),
                title: String(ev.title || '').trim() || 'Cours',
                slotType: 'cours',
                studentsLine: formatEnrolledStudentsLineFromEmails(
                    inscritEmailsFromEvent(ev),
                    elevesByEmail
                ),
                ownerLabel,
                ownerPrenom,
                ownerNom,
                ownerUserId,
                planningColorClass: getPlanningEventColorClass(ev, user)
            });
        }
    }

    if (gen !== nextCoursRefreshGen) return;

    const hasGabaritCards = gabaritHost.childElementCount > 0;
    const hasExceptional = Boolean(exceptional.length);
    if (!hasGabaritCards && !hasExceptional) {
        empty?.classList.remove('hidden');
        empty.textContent = enrollments.length
            ? 'Aucune date de cours planifiée pour le moment.'
            : 'Aucun cours inscrit dans les semaines types.';
    } else {
        empty?.classList.add('hidden');
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
