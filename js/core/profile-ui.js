/**
 * Modale Profil.
 */
import {
    roleLabelFr,
    updateCurrentUserEmail,
    updateCurrentUserPasswordSimple
} from './auth-logic.js';
import { getPlanningSessionUser, setPlanningSessionUser } from './session-user.js';
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { googleCalendarEmbedUrl } from '../utils/google-calendar-url.js';
import { showToast } from '../utils/toast.js';
import { getPlanningThemePref, setPlanningThemePref, applyPlanningTheme } from '../utils/planning-theme.js';
import {
    filterCoursEventsForUser,
    sortEventsByStart,
    formatCoursLineFr,
    fetchCalendarEventsInRange,
    isoWeekRangeLocal
} from './planning-courses.js';

let profileUiBound = false;
let profileSaveInFlight = false;
let profileBaseline = null;

function formatFrPhone(raw) {
    const digits = String(raw || '').replace(/\D+/g, '').slice(0, 10);
    if (!digits) return '';
    return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

function readProfileFormState() {
    const nameEl = document.getElementById('profile-display-name-input');
    const emailEl = document.getElementById('profile-email-input');
    const phoneEl = document.getElementById('profile-phone-input');
    const shareEmailEl = document.getElementById('profile-share-email');
    const sharePhoneEl = document.getElementById('profile-share-phone');
    const shareCalEl = document.getElementById('profile-share-calendar');
    return {
        name: nameEl instanceof HTMLInputElement ? nameEl.value.trim() : '',
        email: emailEl instanceof HTMLInputElement ? emailEl.value.trim() : '',
        phone: phoneEl instanceof HTMLInputElement ? formatFrPhone(phoneEl.value) : '',
        shareEmail: shareEmailEl instanceof HTMLInputElement ? shareEmailEl.checked : true,
        sharePhone: sharePhoneEl instanceof HTMLInputElement ? sharePhoneEl.checked : false,
        shareCalendar: shareCalEl instanceof HTMLInputElement ? shareCalEl.checked : false
    };
}

function syncProfileBaselineFromForm() {
    profileBaseline = readProfileFormState();
}

function isThemeSelectionDirty() {
    const themeSel = document.getElementById('profile-theme-select');
    if (!(themeSel instanceof HTMLSelectElement)) return false;
    const sel = themeSel.value === 'dark' ? 'dark' : 'light';
    return sel !== getPlanningThemePref();
}

function hasProfilePendingChanges() {
    if (!profileBaseline) return false;
    const cur = readProfileFormState();
    const passA = document.getElementById('profile-pass-new');
    const passB = document.getElementById('profile-pass-confirm');
    const hasPwd =
        (passA instanceof HTMLInputElement && passA.value.trim() !== '') ||
        (passB instanceof HTMLInputElement && passB.value.trim() !== '');
    return (
        cur.name !== profileBaseline.name ||
        cur.email !== profileBaseline.email ||
        cur.phone !== profileBaseline.phone ||
        cur.shareEmail !== profileBaseline.shareEmail ||
        cur.sharePhone !== profileBaseline.sharePhone ||
        cur.shareCalendar !== profileBaseline.shareCalendar ||
        hasPwd ||
        isThemeSelectionDirty()
    );
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

/** Ancien bandeau « cours de la semaine » supprimé : nettoie la classe shell si besoin. */
export async function refreshHeaderWeekStrip(_user) {
    document.getElementById('app-shell')?.classList.remove('planning-shell--weekstrip');
}

async function fillProfileModal(user) {
    const displayNameInput = document.getElementById('profile-display-name-input');
    if (displayNameInput instanceof HTMLInputElement) {
        displayNameInput.value = String(user.name || '').trim();
    }
    const emailInput = document.getElementById('profile-email-input');
    if (emailInput instanceof HTMLInputElement) {
        emailInput.value = user.email || '';
    }
    document.getElementById('profile-email-hint')?.classList.add('hidden');

    let tel = String(user.telephone ?? '').trim();
    let shareEmail = user.directory_share_email !== false;
    let sharePhone = user.directory_share_phone === true;
    let shareCalendar = user.directory_share_calendar === true;
    if (isBackendAuthConfigured() && user.id) {
        const sb = getSupabaseClient();
        if (sb) {
            const { data } = await sb
                .from('profiles')
                .select('telephone, directory_share_email, directory_share_phone, directory_share_calendar')
                .eq('id', user.id)
                .maybeSingle();
            if (data) {
                tel = String(data.telephone ?? '').trim();
                shareEmail = data.directory_share_email !== false;
                sharePhone = data.directory_share_phone === true;
                shareCalendar = data.directory_share_calendar === true;
            }
        }
    }
    const phoneInput = document.getElementById('profile-phone-input');
    if (phoneInput instanceof HTMLInputElement) phoneInput.value = formatFrPhone(tel);
    const shE = document.getElementById('profile-share-email');
    if (shE instanceof HTMLInputElement) shE.checked = shareEmail;
    const shP = document.getElementById('profile-share-phone');
    if (shP instanceof HTMLInputElement) shP.checked = sharePhone;
    const shC = document.getElementById('profile-share-calendar');
    if (shC instanceof HTMLInputElement) shC.checked = shareCalendar;
    document.getElementById('profile-role-label').textContent = roleLabelFr(user.role);
    const passNew = document.getElementById('profile-pass-new');
    const passConfirm = document.getElementById('profile-pass-confirm');
    if (passNew instanceof HTMLInputElement) passNew.value = '';
    if (passConfirm instanceof HTMLInputElement) passConfirm.value = '';
    syncProfileBaselineFromForm();

    const isEleve = String(user.role).toLowerCase() === 'eleve';
    document.getElementById('profile-cours-section')?.classList.toggle('hidden', !isEleve);

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

    const themeSel = document.getElementById('profile-theme-select');
    if (themeSel instanceof HTMLSelectElement) {
        themeSel.value = getPlanningThemePref();
    }
}

export function resetProfileUiBindings() {
    profileUiBound = false;
    profileSaveInFlight = false;
    profileBaseline = null;
}

export function initProfileUi(currentUser) {
    if (!currentUser?.email || profileUiBound) return;
    profileUiBound = true;

    document.getElementById('profile-theme-select')?.addEventListener('change', (e) => {
        const el = e.target;
        if (!(el instanceof HTMLSelectElement)) return;
        applyPlanningTheme(el.value === 'dark' ? 'dark' : 'light');
    });

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

    document.getElementById('profile-phone-input')?.addEventListener('blur', (e) => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement)) return;
        el.value = formatFrPhone(el.value);
    });

    const passToggle = document.getElementById('profile-pass-show-plain');
    const applyPassVisibility = (visible) => {
        const type = visible ? 'text' : 'password';
        document.getElementById('profile-pass-new')?.setAttribute('type', type);
        document.getElementById('profile-pass-confirm')?.setAttribute('type', type);
        if (passToggle instanceof HTMLInputElement) passToggle.checked = visible;
    };
    passToggle?.addEventListener('change', (e) =>
        applyPassVisibility(Boolean((e.target instanceof HTMLInputElement && e.target.checked)))
    );
    const profileDlg = document.getElementById('modal_profile');
    profileDlg?.addEventListener('close', () => {
        applyPassVisibility(false);
        applyPlanningTheme(getPlanningThemePref());
    });
    profileDlg?.addEventListener('cancel', (e) => {
        if (!hasProfilePendingChanges()) return;
        e.preventDefault();
        if (confirm('Fermer sans enregistrer les modifications du profil ?')) {
            profileDlg.close();
        }
    });

    document.getElementById('profile-close-btn')?.addEventListener('click', () => {
        if (!profileDlg) return;
        if (hasProfilePendingChanges()) {
            if (!confirm('Fermer sans enregistrer les modifications du profil ?')) return;
        }
        profileDlg.close();
    });

    document.getElementById('profile-save-all')?.addEventListener('click', async () => {
        if (profileSaveInFlight) return;
        const u = getPlanningSessionUser();
        if (!u?.id || !isBackendAuthConfigured()) {
            showToast('Session indisponible.', 'error');
            return;
        }
        const sb = getSupabaseClient();
        if (!sb) {
            showToast('Session indisponible.', 'error');
            return;
        }
        profileSaveInFlight = true;
        const saveBtn = document.getElementById('profile-save-all');
        if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
        try {
            const form = readProfileFormState();
            const telephone = String(form.phone || '').slice(0, 40);
            const { error } = await sb
                .from('profiles')
                .update({
                    display_name: form.name,
                    telephone,
                    directory_share_email: form.shareEmail,
                    directory_share_phone: form.sharePhone,
                    directory_share_calendar: form.shareCalendar
                })
                .eq('id', u.id);
            if (error) {
                showToast(error.message || 'Impossible d’enregistrer.', 'error');
                return;
            }
            const current = getPlanningSessionUser();
            if (current) {
                setPlanningSessionUser({
                    ...current,
                    name: form.name,
                    telephone,
                    directory_share_email: form.shareEmail,
                    directory_share_phone: form.sharePhone,
                    directory_share_calendar: form.shareCalendar
                });
            }
            const previousEmail = String(u.email || '').trim().toLowerCase();
            const nextEmail = String(form.email || '').trim().toLowerCase();
            if (nextEmail && nextEmail !== previousEmail) {
                const emailRes = await updateCurrentUserEmail(form.email);
                if (!emailRes.ok) {
                    showToast(emailRes.error || 'Impossible de modifier l’e-mail.', 'error');
                    return;
                }
                document.getElementById('profile-email-hint')?.classList.remove('hidden');
            }
            const a = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-new'));
            const b = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-confirm'));
            if ((a?.value || '').trim() || (b?.value || '').trim()) {
                const passRes = await updateCurrentUserPasswordSimple(a?.value || '', b?.value || '');
                if (!passRes.ok) {
                    showToast(passRes.error || 'Impossible de modifier le mot de passe.', 'error');
                    return;
                }
                if (a) a.value = '';
                if (b) b.value = '';
                applyPassVisibility(false);
            }
            showToast('Profil enregistré.', 'success');
            const themeSel = document.getElementById('profile-theme-select');
            if (themeSel instanceof HTMLSelectElement) {
                setPlanningThemePref(themeSel.value === 'dark' ? 'dark' : 'light');
            }
            syncProfileBaselineFromForm();
            document.dispatchEvent(new CustomEvent('planning-profile-saved'));
            document.getElementById('modal_profile')?.close();
        } finally {
            profileSaveInFlight = false;
            if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
        }
    });
}
