/**
 * Profil : agendas, cours inscrits (gabarit A/B), tiroir : prochain cours.
 */
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { getPlanningSessionUser } from './session-user.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { showToast } from '../utils/toast.js';
import {
    filterCoursEventsForUser,
    sortEventsByStart,
    formatCoursCardLines,
    fetchCalendarEventsInRange
} from './planning-courses.js';

const AGENDA_HELP =
    'Ces liens permettent d’afficher le planning dans Google Agenda (lecture seule). Dans Google Agenda : Paramètres → Ajouter un agenda → À partir de l’URL. Collez le lien copié. Le planning complet affiche tous les créneaux ; le planning personnel n’affiche que vos réservations IAMS.';

const DOW_FR = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function padTime(t) {
    const s = String(t || '').slice(0, 5);
    const p = s.split(':');
    return `${p[0] || '00'}:${p[1] || '00'}`;
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
        .select('line_id')
        .eq('student_user_id', userId)
        .in('line_id', lids);
    const lineIds = new Set((links || []).map((l) => l.line_id));
    const ownerIds = [...new Set(lines.map((l) => l.owner_user_id).filter(Boolean))];
    const { data: labels } = ownerIds.length
        ? await sb.rpc('planning_profiles_label_for_ids', { p_ids: ownerIds })
        : { data: [] };
    const ownerMap = new Map((labels || []).map((r) => [r.user_id, r.label]));
    return lines
        .filter((l) => lineIds.has(l.id) && String(l.slot_type || '').toLowerCase() === 'cours')
        .map((l) => ({
            ...l,
            ownerLabel: ownerMap.get(l.owner_user_id) || ''
        }));
}

function renderGabaritCoursCard(line, host) {
    const card = document.createElement('article');
    card.className =
        'st-slot-card st-slot-card--eleve-view profile-gabarit-cours-card grid grid-cols-[auto_minmax(0,0.75fr)_minmax(0,1.1fr)_minmax(0,0.95fr)] gap-2 items-stretch rounded-lg border border-slate-200/90 px-2 py-2 min-w-0 text-[10px]';
    const week = line.week_type === 'B' ? 'B' : 'A';
    const dow = DOW_FR[parseInt(String(line.day_of_week || 1), 10)] || '—';
    card.innerHTML = `
        <span class="st-eleve-week-badge text-[9px] font-black uppercase text-sky-800 self-center">Sem. ${week}</span>
        <div class="font-mono text-[10px] leading-snug">${dow}<br/>${padTime(line.start_time)} – ${padTime(line.end_time)}</div>
        <p class="font-semibold m-0 leading-snug self-center">${String(line.title || 'Cours').trim()}</p>
        <p class="m-0 text-right self-center text-slate-600">${String(line.ownerLabel || '').trim() || '—'}</p>`;
    host.appendChild(card);
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
    for (const line of rows) renderGabaritCoursCard(line, list);
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
    const card = document.createElement('article');
    card.className = 'drawer-cours-card profile-gabarit-cours-card';
    card.innerHTML = `<p class="drawer-cours-card__title">${lines.title}</p><p class="drawer-cours-card__meta">${lines.meta}</p><p class="drawer-cours-card__prof">${lines.prof}</p>`;
    cardHost.appendChild(card);
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
