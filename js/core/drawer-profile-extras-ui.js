/**
 * Profil : agendas, cours inscrits (gabarit A/B), tiroir : prochain cours.
 */
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { getPlanningSessionUser } from './session-user.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { showToast } from '../utils/toast.js';
import { appendEleveGabaritCoursCard } from '../utils/template-cours-card-ui.js';
import {
    filterCoursEventsForUser,
    sortEventsByStart,
    formatCoursCardLines,
    fetchCalendarEventsInRange
} from './planning-courses.js';

const AGENDA_HELP =
    'Ces liens permettent d’afficher le planning dans Google Agenda (lecture seule). Dans Google Agenda : Paramètres → Ajouter un agenda → À partir de l’URL. Collez le lien copié. Le planning complet affiche tous les créneaux ; le planning personnel n’affiche que vos réservations IAMS.';

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

    const { mainGoogleCalendarId } = getPlanningConfig();
    const mainUrl = googleCalendarEmbedUrl(mainGoogleCalendarId);
    bindAgendaCopyBtn('drawer-agenda-main-btn', mainUrl);

    const { id: persId } = await loadPersonalPoolRow(user.id);
    const persUrl = googleCalendarEmbedUrl(persId);

    const persBtn = document.getElementById('drawer-agenda-personal-btn');
    const persNone = document.getElementById('drawer-agenda-personal-none');
    if (persUrl) {
        bindAgendaCopyBtn('drawer-agenda-personal-btn', persUrl);
        persNone?.classList.add('hidden');
        persBtn?.classList.remove('hidden');
    } else {
        persBtn?.classList.add('hidden');
        persNone?.classList.remove('hidden');
    }
}

function studentsLineFromIds(ids, labelById) {
    const names = (ids || [])
        .map((id) => String(labelById.get(id) || '').trim())
        .filter(Boolean);
    return names.join(', ') || '—';
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
    const allUserIds = [
        ...new Set([
            ...lines.map((l) => l.owner_user_id).filter(Boolean),
            ...(links || []).map((l) => l.student_user_id)
        ])
    ];
    const { data: labels } = allUserIds.length
        ? await sb.rpc('planning_profiles_label_for_ids', { p_ids: allUserIds })
        : { data: [] };
    const labelMap = new Map((labels || []).map((r) => [r.user_id, r.label]));
    return lines
        .filter((l) => lineIds.has(l.id) && String(l.slot_type || '').toLowerCase() === 'cours')
        .map((l) => ({
            ...l,
            ownerLabel: labelMap.get(l.owner_user_id) || '',
            studentsLine: studentsLineFromIds(studentsByLine.get(l.id) || [], labelMap)
        }));
}

function appendWeekSectionTitle(host, week) {
    const h = document.createElement('p');
    h.className =
        'profile-cours-week-title text-[10px] font-bold uppercase text-slate-600 dark:text-slate-300 tracking-wide m-0 mt-2 mb-1 first:mt-0';
    h.textContent = week === 'B' ? 'Semaine B' : 'Semaine A';
    host.appendChild(h);
}

function renderProfileCoursGrouped(rows, list) {
    const byWeek = { A: [], B: [] };
    for (const line of rows) {
        const w = line.week_type === 'B' ? 'B' : 'A';
        byWeek[w].push(line);
    }
    for (const w of ['A', 'B']) {
        if (!byWeek[w].length) continue;
        appendWeekSectionTitle(list, w);
        for (const line of byWeek[w]) {
            appendEleveGabaritCoursCard(list, {
                dayOfWeek: line.day_of_week,
                startTime: line.start_time,
                endTime: line.end_time,
                title: line.title,
                slotType: line.slot_type,
                studentsLine: line.studentsLine,
                ownerLabel: line.ownerLabel,
                ownerUserId: line.owner_user_id
            });
        }
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
    renderProfileCoursGrouped(rows, list);
}

/** @param {object | null} user */
export async function refreshDrawerNextCours(user) {
    const block = document.getElementById('drawer-section-next-cours');
    const cardHost = document.getElementById('drawer-next-cours-card');
    const empty = document.getElementById('drawer-next-cours-empty');
    if (!block || !cardHost) return;

    const isEleve = String(user?.role || '').toLowerCase() === 'eleve';
    block.classList.toggle('hidden', !isEleve || !user?.email);
    cardHost.classList.add('hidden');
    cardHost.replaceChildren();
    if (!isEleve || !user?.email) return;

    const start = new Date();
    const end = new Date(start);
    end.setDate(end.getDate() + 120);
    let items = [];
    try {
        const evs = await fetchCalendarEventsInRange(start, end);
        items = sortEventsByStart(filterCoursEventsForUser(evs, user));
    } catch {
        /* */
    }
    const now = Date.now();
    const next = items.find((ev) => {
        const t = new Date(String(ev?.start ?? '')).getTime();
        return !Number.isNaN(t) && t >= now;
    });
    if (!next) {
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');
    cardHost.classList.remove('hidden');
    const lines = formatCoursCardLines(next);
    const startDt = new Date(String(next.start ?? ''));
    appendEleveGabaritCoursCard(cardHost, {
        dayOfWeek: jsDateToPlanningDow(startDt),
        startTime: startDt.toISOString(),
        endTime: String(next.end ?? ''),
        title: lines.title,
        slotType: 'cours',
        studentsLine: lines.students || '—',
        ownerLabel: lines.prof,
        ownerUserId: '',
        dateSubline: lines.dateSubline || ''
    });
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
        void refreshDrawerProfileExtras(u);
    });
}

export function resetDrawerProfileExtrasBindings() {
    bound = false;
}
