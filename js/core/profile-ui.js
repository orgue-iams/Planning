/**
 * Modale Profil + bandeau « cours de la semaine » dans l’en-tête.
 */
import { roleLabelFr, isPrivilegedUser } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { getProfile, saveProfile } from '../utils/user-profile.js';
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { showToast } from '../utils/toast.js';
import {
    filterCoursEventsForUser,
    sortEventsByStart,
    formatCoursLineFr,
    fetchCalendarEventsInRange,
    isoWeekRangeLocal
} from './planning-courses.js';

let profileUiBound = false;

function parseTitleLines(raw) {
    return String(raw || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

function renderPreferredRadios(wrap, lines, preferredIndex) {
    if (!wrap) return;
    wrap.replaceChildren();
    if (!lines.length) {
        const p = document.createElement('p');
        p.className = 'text-[10px] text-slate-400 leading-snug m-0';
        p.textContent =
            'Ajoutez au moins une ligne ci-dessus pour choisir le titre proposé par défaut dans la modale.';
        wrap.appendChild(p);
        return;
    }
    const legend = document.createElement('p');
    legend.className = 'text-[10px] font-bold text-slate-500 mb-1.5 m-0';
    legend.textContent = 'Titre par défaut (modale) :';
    wrap.appendChild(legend);
    let idx = preferredIndex;
    if (idx < 0 || idx >= lines.length) idx = 0;
    lines.forEach((line, i) => {
        const label = document.createElement('label');
        label.className = 'flex items-start gap-2 cursor-pointer text-[12px] text-slate-800 leading-snug';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'profile-preferred-title';
        radio.value = String(i);
        radio.checked = i === idx;
        const span = document.createElement('span');
        span.textContent = line;
        label.append(radio, span);
        wrap.appendChild(label);
    });
}

function readPreferredIndex(wrap) {
    if (!wrap) return 0;
    const c = wrap.querySelector('input[name="profile-preferred-title"]:checked');
    const v = c ? parseInt(String(c.value), 10) : 0;
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

function refreshProfileTitleRadios() {
    const ta = document.getElementById('profile-title-lines');
    const prefWrap = document.getElementById('profile-preferred-wrap');
    const u = getPlanningSessionUser();
    if (!u?.email || !ta || !prefWrap) return;
    const lines = parseTitleLines(ta.value);
    let preferred = readPreferredIndex(prefWrap);
    if (preferred >= lines.length) preferred = Math.max(0, lines.length - 1);
    renderPreferredRadios(prefWrap, lines, preferred);
}

async function loadPersonalPoolRow(userId) {
    if (!isBackendAuthConfigured() || !userId) {
        return { id: '', label: '' };
    }
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

async function copyInputUrl(inputId) {
    const el = document.getElementById(inputId);
    const v = el instanceof HTMLInputElement ? el.value.trim() : '';
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

/** Bandeau sous la barre : prochains cours de la semaine civile (lundi–dimanche) ou message + prochain hors semaine. */
export async function refreshHeaderWeekStrip(user) {
    const wrap = document.getElementById('header-week-strip-wrap');
    const el = document.getElementById('header-week-courses');
    if (!wrap || !el) return;
    if (!user?.email) {
        wrap.classList.add('hidden');
        el.textContent = '';
        return;
    }
    wrap.classList.remove('hidden');
    el.textContent = 'Chargement des cours…';

    try {
        const { start, end } = isoWeekRangeLocal(new Date());
        const all = await fetchCalendarEventsInRange(start, end);
        const myCours = sortEventsByStart(filterCoursEventsForUser(all, user));
        const now = new Date();
        const inWeekFuture = myCours.filter((e) => new Date(String(e.start)) >= now);

        if (inWeekFuture.length > 0) {
            const lines = inWeekFuture.map(formatCoursLineFr);
            const max = 3;
            const shown = lines.slice(0, max);
            el.textContent =
                lines.length > max
                    ? `Cette semaine : ${shown.join(' · ')} · (+${lines.length - max} autre(s))`
                    : `Cette semaine : ${shown.join(' · ')}`;
            el.title = lines.join('\n');
            return;
        }

        const after = new Date(end.getTime() + 1);
        const horizon = new Date(after);
        horizon.setDate(horizon.getDate() + 120);
        const more = await fetchCalendarEventsInRange(after, horizon);
        const nextAll = sortEventsByStart(filterCoursEventsForUser(more, user)).filter(
            (e) => new Date(String(e.start)) >= now
        );
        const next = nextAll[0];
        if (next) {
            const d = new Date(String(next.start));
            const dateStr = d.toLocaleDateString('fr-FR', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });
            const hour = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            el.textContent = `Pas de cours cette semaine, le prochain cours sera le ${dateStr} à ${hour} : ${String(next.title || 'Cours').trim()}`;
        } else {
            el.textContent =
                'Pas de cours cette semaine, aucun cours à venir trouvé dans l’agenda pour votre compte.';
        }
        el.title = '';
    } catch {
        el.textContent = 'Impossible de charger les cours (agenda).';
        el.title = '';
    }
}

async function fillProfileModal(user) {
    document.getElementById('profile-display-name').textContent = user.name || '—';
    document.getElementById('profile-email').textContent = user.email || '—';
    document.getElementById('profile-role-label').textContent = roleLabelFr(user.role);

    const hint = document.getElementById('profile-cours-hint');
    if (hint) {
        hint.classList.toggle('hidden', String(user.role).toLowerCase() !== 'eleve');
    }

    const { mainGoogleCalendarId, mainGoogleCalendarLabel } = getPlanningConfig();
    const mainUrl = googleCalendarEmbedUrl(mainGoogleCalendarId);
    const rowMain = document.getElementById('profile-row-main-cal');
    const inpMain = document.getElementById('profile-url-main');
    const nameMain = document.getElementById('profile-main-cal-name');
    const mainDisplayName =
        mainGoogleCalendarLabel.trim() ||
        (mainGoogleCalendarId ? mainGoogleCalendarId.split('@')[0] || mainGoogleCalendarId : '');
    if (mainUrl && rowMain && inpMain) {
        rowMain.classList.remove('hidden');
        inpMain.value = mainUrl;
        if (nameMain) nameMain.textContent = mainDisplayName || 'Planning général';
    } else if (rowMain) {
        rowMain.classList.add('hidden');
        if (inpMain) inpMain.value = '';
        if (nameMain) nameMain.textContent = '';
    }

    const rowPers = document.getElementById('profile-row-personal-cal');
    const inpPers = document.getElementById('profile-url-personal');
    const namePers = document.getElementById('profile-personal-cal-name');
    const nonePers = document.getElementById('profile-personal-cal-none');
    const { id: persId, label: persLabel } = await loadPersonalPoolRow(user.id);
    const persUrl = googleCalendarEmbedUrl(persId);
    const isConsultation = String(user.role).toLowerCase() === 'consultation';

    if (persUrl && rowPers && inpPers) {
        rowPers.classList.remove('hidden');
        inpPers.value = persUrl;
        nonePers?.classList.add('hidden');
        if (namePers) {
            namePers.textContent =
                persLabel.trim() ||
                (persId.includes('@') ? persId.split('@')[0] : persId) ||
                'Calendrier personnel';
        }
    } else {
        rowPers?.classList.add('hidden');
        if (inpPers) inpPers.value = '';
        if (namePers) namePers.textContent = '';
        if (nonePers) {
            nonePers.classList.remove('hidden');
            nonePers.textContent = isConsultation
                ? 'Profil consultation : aucun calendrier personnel IAMS n’est attribué.'
                : 'Aucun calendrier secondaire IAMS n’est associé à votre compte pour le moment.';
        }
    }

    const ul = document.getElementById('profile-cours-list');
    const empty = document.getElementById('profile-cours-empty');
    if (ul) ul.replaceChildren();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 60);
    let list = [];
    try {
        const evs = await fetchCalendarEventsInRange(start, end);
        list = sortEventsByStart(filterCoursEventsForUser(evs, user));
    } catch {
        /* */
    }
    if (ul) {
        for (const ev of list) {
            const li = document.createElement('li');
            li.className = 'pl-0 border-l-2 border-slate-200 pl-2';
            li.textContent = formatCoursLineFr(ev);
            ul.appendChild(li);
        }
    }
    if (empty) {
        empty.classList.toggle('hidden', list.length > 0);
    }

    const titlesWrap = document.getElementById('profile-reservation-titles-wrap');
    const ta = document.getElementById('profile-title-lines');
    const prefWrap = document.getElementById('profile-preferred-wrap');
    const showTitles = isPrivilegedUser(user);
    if (titlesWrap) titlesWrap.classList.toggle('hidden', !showTitles);
    if (showTitles && ta && prefWrap && user.email) {
        const p = getProfile(user.email);
        ta.value = p.titleLines.join('\n');
        renderPreferredRadios(prefWrap, p.titleLines, p.preferredIndex);
    }

}

export function resetProfileUiBindings() {
    profileUiBound = false;
}

export function initProfileUi(currentUser) {
    if (!currentUser?.email || profileUiBound) return;
    profileUiBound = true;

    document.getElementById('menu-item-profile')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        const dlg = document.getElementById('modal_profile');
        if (!dlg) {
            showToast('Fenêtre profil indisponible. Rechargez la page.', 'error');
            return;
        }
        const u = getPlanningSessionUser();
        if (!u?.email) return;
        requestAnimationFrame(() => {
            void fillProfileModal(u).then(() => dlg.showModal());
        });
    });

    document.getElementById('profile-copy-main')?.addEventListener('click', () => void copyInputUrl('profile-url-main'));
    document.getElementById('profile-copy-personal')?.addEventListener('click', () =>
        void copyInputUrl('profile-url-personal')
    );

    document.getElementById('profile-title-lines')?.addEventListener('input', () => refreshProfileTitleRadios());

    document.getElementById('profile-labels-btn-save')?.addEventListener('click', async () => {
        const u = getPlanningSessionUser();
        const ta = document.getElementById('profile-title-lines');
        const prefWrap = document.getElementById('profile-preferred-wrap');
        if (!u?.email || !ta) return;
        const lines = parseTitleLines(ta.value);
        refreshProfileTitleRadios();
        const preferredIndex = readPreferredIndex(prefWrap);
        await saveProfile(u.email, lines, preferredIndex);
        showToast('Titres enregistrés.');
    });

}
