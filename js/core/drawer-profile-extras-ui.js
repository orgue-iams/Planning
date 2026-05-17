/**
 * Tiroir : agendas Google (copie URL) et cours inscrits (lecture seule).
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

function setAgendaHelpExpanded(expanded) {
    const help = document.getElementById('drawer-agenda-help-text');
    const btn = document.getElementById('drawer-agenda-help-btn');
    if (help) {
        help.textContent = AGENDA_HELP;
        help.classList.toggle('hidden', !expanded);
    }
    if (btn instanceof HTMLButtonElement) {
        btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
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

/** @param {object | null} user */
export async function refreshDrawerCoursInscrits(user) {
    const block = document.getElementById('drawer-section-cours');
    const list = document.getElementById('drawer-cours-list');
    const empty = document.getElementById('drawer-cours-empty');
    if (!block || !list) return;

    const isEleve = String(user?.role || '').toLowerCase() === 'eleve';
    block.classList.toggle('hidden', !isEleve || !user?.email);
    if (!isEleve || !user?.email) {
        list.replaceChildren();
        return;
    }

    list.replaceChildren();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 60);
    let items = [];
    try {
        const evs = await fetchCalendarEventsInRange(start, end);
        items = sortEventsByStart(filterCoursEventsForUser(evs, user));
    } catch {
        /* */
    }

    if (!items.length) {
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');

    for (const ev of items) {
        const card = document.createElement('article');
        card.className = 'drawer-cours-card';
        const lines = formatCoursCardLines(ev);
        const title = document.createElement('p');
        title.className = 'drawer-cours-card__title';
        title.textContent = lines.title;
        const meta = document.createElement('p');
        meta.className = 'drawer-cours-card__meta';
        meta.textContent = lines.meta;
        const prof = document.createElement('p');
        prof.className = 'drawer-cours-card__prof';
        prof.textContent = lines.prof;
        card.append(title, meta, prof);
        list.appendChild(card);
    }
}

/** @param {object | null} user */
export async function refreshDrawerProfileExtras(user) {
    await refreshDrawerAgendas(user);
    await refreshDrawerCoursInscrits(user);
}

let bound = false;

export function initDrawerProfileExtrasUi() {
    if (bound) return;
    bound = true;

    document.getElementById('drawer-agenda-help-btn')?.addEventListener('click', () => {
        const help = document.getElementById('drawer-agenda-help-text');
        const expanded = help?.classList.contains('hidden') ?? true;
        setAgendaHelpExpanded(expanded);
    });
    setAgendaHelpExpanded(false);

    document.addEventListener('planning-profile-saved', () => {
        const u = getPlanningSessionUser();
        void refreshDrawerProfileExtras(u);
    });
}
