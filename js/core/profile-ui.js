/**
 * Modale Profil — enregistrement progressif (champs + mot de passe sur action).
 */
import {
    roleLabelFr,
    updateCurrentUserPasswordSimple,
    PASSWORD_MIN_LENGTH
} from './auth-logic.js';
import { getPlanningSessionUser, setPlanningSessionUser } from './session-user.js';
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { showToast } from '../utils/toast.js';
import { openPlanningRouteFromDrawer } from '../utils/planning-route-dialog.js';
import { refreshDrawerProfileExtras } from './drawer-profile-extras-ui.js';
import { formatProfileFullName, parseDisplayNameToNomPrenom } from '../utils/profile-full-name.js';

let profileUiBound = false;
let profileSaveInFlight = false;
let profileBaseline = null;
let profileFieldTimer = 0;

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
    const showSundayEl = document.getElementById('profile-show-sunday');
    return {
        name: nameEl instanceof HTMLInputElement ? nameEl.value.trim() : '',
        email: emailEl instanceof HTMLInputElement ? emailEl.value.trim() : '',
        phone: phoneEl instanceof HTMLInputElement ? formatFrPhone(phoneEl.value) : '',
        shareEmail: shareEmailEl instanceof HTMLInputElement ? shareEmailEl.checked : true,
        sharePhone: sharePhoneEl instanceof HTMLInputElement ? sharePhoneEl.checked : false,
        showSunday: showSundayEl instanceof HTMLInputElement ? showSundayEl.checked : false
    };
}

function syncProfileBaselineFromForm() {
    profileBaseline = readProfileFormState();
}

function hasProfileFieldChangesVsBaseline() {
    if (!profileBaseline) return false;
    const cur = readProfileFormState();
    return (
        cur.name !== profileBaseline.name ||
        cur.phone !== profileBaseline.phone ||
        cur.shareEmail !== profileBaseline.shareEmail ||
        cur.sharePhone !== profileBaseline.sharePhone ||
        cur.showSunday !== profileBaseline.showSunday
    );
}

function setPassHint(msg, kind) {
    const hint = document.getElementById('profile-pass-hint');
    if (!(hint instanceof HTMLElement)) return;
    if (!msg) {
        hint.classList.add('hidden');
        hint.textContent = '';
        return;
    }
    hint.classList.remove('hidden');
    hint.textContent = msg;
    hint.classList.remove('text-error', 'text-success', 'text-slate-600');
    if (kind === 'error') hint.classList.add('text-error');
    else if (kind === 'success') hint.classList.add('text-success');
    else hint.classList.add('text-slate-600');
}

function syncProfilePassApplyState() {
    const a = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-new'));
    const b = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-confirm'));
    const btn = document.getElementById('profile-pass-apply');
    const av = (a?.value || '').trim();
    const bv = (b?.value || '').trim();
    if (!av && !bv) {
        setPassHint('', '');
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        return;
    }
    if (av !== bv) {
        setPassHint('Mots de passe non identiques.', 'error');
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        return;
    }
    if (av.length < PASSWORD_MIN_LENGTH) {
        setPassHint(`Au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        return;
    }
    setPassHint('Les mots de passe correspondent.', 'muted');
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
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

    let tel = String(user.telephone ?? '').trim();
    let shareEmail = user.directory_share_email !== false;
    let sharePhone = user.directory_share_phone === true;
    let showSunday = user.planning_show_sunday === true;
    if (isBackendAuthConfigured() && user.id) {
        const sb = getSupabaseClient();
        if (sb) {
            const { data } = await sb
                .from('profiles')
                .select(
                    'telephone, directory_share_email, directory_share_phone, planning_show_sunday'
                )
                .eq('id', user.id)
                .maybeSingle();
            if (data) {
                tel = String(data.telephone ?? '').trim();
                shareEmail = data.directory_share_email !== false;
                sharePhone = data.directory_share_phone === true;
                showSunday = data.planning_show_sunday === true;
            }
        }
    }
    const phoneInput = document.getElementById('profile-phone-input');
    if (phoneInput instanceof HTMLInputElement) phoneInput.value = formatFrPhone(tel);
    const shE = document.getElementById('profile-share-email');
    if (shE instanceof HTMLInputElement) shE.checked = shareEmail;
    const shP = document.getElementById('profile-share-phone');
    if (shP instanceof HTMLInputElement) shP.checked = sharePhone;
    const shSun = document.getElementById('profile-show-sunday');
    if (shSun instanceof HTMLInputElement) shSun.checked = showSunday;
    document.getElementById('profile-role-label').textContent = roleLabelFr(user.role);
    const passNew = document.getElementById('profile-pass-new');
    const passConfirm = document.getElementById('profile-pass-confirm');
    if (passNew instanceof HTMLInputElement) passNew.value = '';
    if (passConfirm instanceof HTMLInputElement) passConfirm.value = '';
    syncProfilePassApplyState();
    syncProfileBaselineFromForm();
    await refreshDrawerProfileExtras(user);
}

export async function persistProfileFields() {
    if (profileSaveInFlight) return;
    if (!hasProfileFieldChangesVsBaseline()) return;
    const u = getPlanningSessionUser();
    if (!u?.id || !isBackendAuthConfigured()) return;
    const sb = getSupabaseClient();
    if (!sb) return;
    profileSaveInFlight = true;
    try {
        const form = readProfileFormState();
        const telephone = String(form.phone || '').slice(0, 40);
        const { nom, prenom } = parseDisplayNameToNomPrenom(form.name);
        const display_name = formatProfileFullName(nom, prenom) || form.name;
        const { error } = await sb
            .from('profiles')
            .update({
                nom,
                prenom,
                display_name,
                telephone,
                directory_share_email: form.shareEmail,
                directory_share_phone: form.sharePhone,
                planning_show_sunday: form.showSunday
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
                name: display_name,
                telephone,
                directory_share_email: form.shareEmail,
                directory_share_phone: form.sharePhone,
                planning_show_sunday: form.showSunday
            });
        }
        syncProfileBaselineFromForm();
        document.dispatchEvent(new CustomEvent('planning-profile-saved'));
    } finally {
        profileSaveInFlight = false;
    }
}

function scheduleProfileFieldsPersist() {
    window.clearTimeout(profileFieldTimer);
    profileFieldTimer = window.setTimeout(() => void persistProfileFields(), 450);
}

async function applyProfilePassword() {
    const a = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-new'));
    const b = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-confirm'));
    const av = (a?.value || '').trim();
    const bv = (b?.value || '').trim();
    if (!av && !bv) return;
    syncProfilePassApplyState();
    if (av !== bv || av.length < PASSWORD_MIN_LENGTH) return;
    const passRes = await updateCurrentUserPasswordSimple(av, bv);
    if (!passRes.ok) {
        setPassHint(passRes.error || 'Impossible de modifier le mot de passe.', 'error');
        return;
    }
    if (a) a.value = '';
    if (b) b.value = '';
    resetProfilePasswordToggles();
    syncProfilePassApplyState();
    setPassHint('Mot de passe changé.', 'success');
}

function resetProfilePasswordToggles() {
    for (const id of ['profile-pass-new', 'profile-pass-confirm']) {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement) el.type = 'password';
    }
    document.querySelectorAll('#modal_profile [data-profile-pw-toggle]').forEach((node) => {
        const btn = /** @type {HTMLButtonElement} */ (node);
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', 'Afficher le mot de passe');
        btn.querySelector('.planning-pass-toggle__show')?.classList.remove('hidden');
        btn.querySelector('.planning-pass-toggle__hide')?.classList.add('hidden');
    });
}

export function resetProfileUiBindings() {
    profileUiBound = false;
    profileSaveInFlight = false;
    profileBaseline = null;
}

export function initProfileUi(currentUser) {
    if (!currentUser?.email || profileUiBound) return;
    profileUiBound = true;

    document.getElementById('menu-item-profile')?.addEventListener('click', (e) => {
        e.preventDefault();
        const dlg = document.getElementById('modal_profile');
        if (!dlg) {
            showToast('Fenêtre profil indisponible. Rechargez la page.', 'error');
            return;
        }
        const u = getPlanningSessionUser();
        if (!u?.email) return;
        if (!openPlanningRouteFromDrawer('modal_profile', 'Mon profil', 'Menu')) return;
        void (async () => {
            await fillProfileModal(u);
            await refreshDrawerProfileExtras(u);
        })();
    });

    document.getElementById('profile-phone-input')?.addEventListener('blur', (e) => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement)) return;
        el.value = formatFrPhone(el.value);
        void persistProfileFields();
    });

    document.getElementById('modal_profile')?.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('[data-profile-pw-toggle]') : null;
        if (!(btn instanceof HTMLButtonElement)) return;
        const id = btn.getAttribute('data-profile-pw-toggle');
        const input = id ? document.getElementById(id) : null;
        if (!(input instanceof HTMLInputElement)) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
        btn.querySelector('.planning-pass-toggle__show')?.classList.toggle('hidden', show);
        btn.querySelector('.planning-pass-toggle__hide')?.classList.toggle('hidden', !show);
    });
    const profileDlg = document.getElementById('modal_profile');
    profileDlg?.addEventListener('close', () => {
        resetProfilePasswordToggles();
        void persistProfileFields();
    });

    document.addEventListener('planning-overlay-flush', () => {
        void persistProfileFields();
    });

    const applyShowSundayToSession = () => {
        const form = readProfileFormState();
        const cur = getPlanningSessionUser();
        if (!cur) return;
        setPlanningSessionUser({ ...cur, planning_show_sunday: form.showSunday });
        document.dispatchEvent(new CustomEvent('planning-profile-saved'));
    };

    for (const id of ['profile-display-name-input', 'profile-share-email', 'profile-share-phone']) {
        const el = document.getElementById(id);
        el?.addEventListener('input', scheduleProfileFieldsPersist);
        el?.addEventListener('change', scheduleProfileFieldsPersist);
        el?.addEventListener('blur', () => void persistProfileFields());
    }

    const showSundayEl = document.getElementById('profile-show-sunday');
    showSundayEl?.addEventListener('change', () => {
        applyShowSundayToSession();
        scheduleProfileFieldsPersist();
    });
    showSundayEl?.addEventListener('blur', () => void persistProfileFields());

    document.getElementById('profile-pass-new')?.addEventListener('input', syncProfilePassApplyState);
    document.getElementById('profile-pass-confirm')?.addEventListener('input', syncProfilePassApplyState);
    document.getElementById('profile-pass-apply')?.addEventListener('click', () => void applyProfilePassword());

    document.getElementById('profile-display-name-input')?.addEventListener('blur', () =>
        void persistProfileFields()
    );
}
