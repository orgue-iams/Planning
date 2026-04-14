/**
 * Modale Profil + bandeau « cours de la semaine » dans l’en-tête.
 */
import {
    roleLabelFr,
    updateCurrentUserEmail,
    updateCurrentUserPasswordSimple
} from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { showToast } from '../utils/toast.js';
import { formatTimeFr24 } from '../utils/time-helpers.js';
import {
    filterCoursEventsForUser,
    sortEventsByStart,
    formatCoursLineFr,
    fetchCalendarEventsInRange,
    isoWeekRangeLocal
} from './planning-courses.js';

let profileUiBound = false;

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
    const r = String(user.role || '').toLowerCase();
    if (r === 'admin' || r === 'prof') {
        wrap.classList.add('hidden');
        el.textContent = '';
        el.title = '';
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
            const hour = formatTimeFr24(d);
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
    const emailInput = document.getElementById('profile-email-input');
    if (emailInput instanceof HTMLInputElement) {
        emailInput.value = user.email || '';
    }
    document.getElementById('profile-email-hint')?.classList.add('hidden');
    document.getElementById('profile-role-label').textContent = roleLabelFr(user.role);
    const passNew = document.getElementById('profile-pass-new');
    const passConfirm = document.getElementById('profile-pass-confirm');
    if (passNew instanceof HTMLInputElement) passNew.value = '';
    if (passConfirm instanceof HTMLInputElement) passConfirm.value = '';

    const isEleve = String(user.role).toLowerCase() === 'eleve';
    document.getElementById('profile-cours-section')?.classList.toggle('hidden', !isEleve);

    const hint = document.getElementById('profile-cours-hint');
    if (hint) {
        hint.classList.toggle('hidden', !isEleve);
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
            nonePers.textContent =
                'Aucun calendrier secondaire IAMS n’est associé à votre compte pour le moment.';
        }
    }

    const ul = document.getElementById('profile-cours-list');
    const empty = document.getElementById('profile-cours-empty');
    if (ul) ul.replaceChildren();
    let list = [];
    if (isEleve) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 60);
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
    } else if (empty) {
        empty.classList.add('hidden');
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

    document.getElementById('profile-email-save')?.addEventListener('click', async () => {
        const input = document.getElementById('profile-email-input');
        if (!(input instanceof HTMLInputElement)) return;
        const res = await updateCurrentUserEmail(input.value);
        if (!res.ok) {
            showToast(res.error || 'Impossible de modifier l’e-mail.', 'error');
            return;
        }
        document.getElementById('profile-email-hint')?.classList.remove('hidden');
        showToast('Demande de changement d’e-mail enregistrée.', 'success');
    });

    const passToggle = document.getElementById('profile-pass-toggle');
    const passShow = document.getElementById('profile-pass-icon-show');
    const passHide = document.getElementById('profile-pass-icon-hide');
    const applyPassVisibility = (visible) => {
        const type = visible ? 'text' : 'password';
        document.getElementById('profile-pass-new')?.setAttribute('type', type);
        document.getElementById('profile-pass-confirm')?.setAttribute('type', type);
        passToggle?.setAttribute('aria-pressed', String(visible));
        passToggle?.setAttribute(
            'aria-label',
            visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'
        );
        passShow?.classList.toggle('hidden', visible);
        passHide?.classList.toggle('hidden', !visible);
    };
    passToggle?.addEventListener('click', () => {
        const vis = document.getElementById('profile-pass-new')?.getAttribute('type') === 'text';
        applyPassVisibility(!vis);
    });
    document.getElementById('modal_profile')?.addEventListener('close', () => applyPassVisibility(false));

    document.getElementById('profile-pass-save')?.addEventListener('click', async () => {
        const a = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-new'));
        const b = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-confirm'));
        const res = await updateCurrentUserPasswordSimple(a?.value || '', b?.value || '');
        if (!res.ok) {
            showToast(res.error || 'Impossible de modifier le mot de passe.', 'error');
            return;
        }
        if (a) a.value = '';
        if (b) b.value = '';
        applyPassVisibility(false);
        showToast('Mot de passe modifié avec succès.', 'success');
    });
}
