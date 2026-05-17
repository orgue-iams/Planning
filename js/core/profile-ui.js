/**
 * Modale Profil — enregistrement progressif (champs + mot de passe).
 */
import {
    roleLabelFr,
    updateCurrentUserEmail,
    updateCurrentUserPasswordSimple,
    PASSWORD_MIN_LENGTH
} from './auth-logic.js';
import { getPlanningSessionUser, setPlanningSessionUser } from './session-user.js';
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { showToast } from '../utils/toast.js';
import { openPlanningRouteFromDrawer } from '../utils/planning-route-dialog.js';
import { refreshDrawerProfileExtras } from './drawer-profile-extras-ui.js';

let profileUiBound = false;
let profileSaveInFlight = false;
let profileBaseline = null;
let profileFieldTimer = 0;
let profilePwdTimer = 0;

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
    return {
        name: nameEl instanceof HTMLInputElement ? nameEl.value.trim() : '',
        email: emailEl instanceof HTMLInputElement ? emailEl.value.trim() : '',
        phone: phoneEl instanceof HTMLInputElement ? formatFrPhone(phoneEl.value) : '',
        shareEmail: shareEmailEl instanceof HTMLInputElement ? shareEmailEl.checked : true,
        sharePhone: sharePhoneEl instanceof HTMLInputElement ? sharePhoneEl.checked : false
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
        cur.email !== profileBaseline.email ||
        cur.phone !== profileBaseline.phone ||
        cur.shareEmail !== profileBaseline.shareEmail ||
        cur.sharePhone !== profileBaseline.sharePhone
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

function syncProfilePassHint() {
    const a = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-new'));
    const b = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-confirm'));
    const av = (a?.value || '').trim();
    const bv = (b?.value || '').trim();
    if (!av && !bv) {
        setPassHint('', '');
        return;
    }
    if (av !== bv) {
        setPassHint('Mots de passe non identiques.', 'error');
        return;
    }
    if (av.length < PASSWORD_MIN_LENGTH) {
        setPassHint(`Au moins ${PASSWORD_MIN_LENGTH} caractères.`, 'error');
        return;
    }
    setPassHint('Les mots de passe correspondent.', 'muted');
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
    if (isBackendAuthConfigured() && user.id) {
        const sb = getSupabaseClient();
        if (sb) {
            const { data } = await sb
                .from('profiles')
                .select('telephone, directory_share_email, directory_share_phone')
                .eq('id', user.id)
                .maybeSingle();
            if (data) {
                tel = String(data.telephone ?? '').trim();
                shareEmail = data.directory_share_email !== false;
                sharePhone = data.directory_share_phone === true;
            }
        }
    }
    const phoneInput = document.getElementById('profile-phone-input');
    if (phoneInput instanceof HTMLInputElement) phoneInput.value = formatFrPhone(tel);
    const shE = document.getElementById('profile-share-email');
    if (shE instanceof HTMLInputElement) shE.checked = shareEmail;
    const shP = document.getElementById('profile-share-phone');
    if (shP instanceof HTMLInputElement) shP.checked = sharePhone;
    document.getElementById('profile-role-label').textContent = roleLabelFr(user.role);
    const passNew = document.getElementById('profile-pass-new');
    const passConfirm = document.getElementById('profile-pass-confirm');
    if (passNew instanceof HTMLInputElement) passNew.value = '';
    if (passConfirm instanceof HTMLInputElement) passConfirm.value = '';
    setPassHint('', '');
    syncProfileBaselineFromForm();
    await refreshDrawerProfileExtras(user);
}

async function persistProfileFields() {
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
        const { error } = await sb
            .from('profiles')
            .update({
                display_name: form.name,
                telephone,
                directory_share_email: form.shareEmail,
                directory_share_phone: form.sharePhone
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
                directory_share_phone: form.sharePhone
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

async function tryPersistPassword() {
    const a = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-new'));
    const b = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-pass-confirm'));
    const av = (a?.value || '').trim();
    const bv = (b?.value || '').trim();
    if (!av && !bv) return;
    if (av !== bv || av.length < PASSWORD_MIN_LENGTH) return;
    const passRes = await updateCurrentUserPasswordSimple(av, bv);
    if (!passRes.ok) {
        setPassHint(passRes.error || 'Impossible de modifier le mot de passe.', 'error');
        return;
    }
    if (a) a.value = '';
    if (b) b.value = '';
    const passToggle = document.getElementById('profile-pass-show-plain');
    if (passToggle instanceof HTMLInputElement) passToggle.checked = false;
    document.getElementById('profile-pass-new')?.setAttribute('type', 'password');
    document.getElementById('profile-pass-confirm')?.setAttribute('type', 'password');
    setPassHint('Mot de passe changé.', 'success');
}

function schedulePasswordPersist() {
    window.clearTimeout(profilePwdTimer);
    profilePwdTimer = window.setTimeout(() => void tryPersistPassword(), 600);
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
    });

    const passToggle = document.getElementById('profile-pass-show-plain');
    const applyPassVisibility = (visible) => {
        const type = visible ? 'text' : 'password';
        document.getElementById('profile-pass-new')?.setAttribute('type', type);
        document.getElementById('profile-pass-confirm')?.setAttribute('type', type);
        if (passToggle instanceof HTMLInputElement) passToggle.checked = visible;
    };
    passToggle?.addEventListener('change', (e) =>
        applyPassVisibility(Boolean(e.target instanceof HTMLInputElement && e.target.checked))
    );
    const profileDlg = document.getElementById('modal_profile');
    profileDlg?.addEventListener('close', () => {
        applyPassVisibility(false);
    });

    for (const id of [
        'profile-display-name-input',
        'profile-email-input',
        'profile-phone-input',
        'profile-share-email',
        'profile-share-phone'
    ]) {
        document.getElementById(id)?.addEventListener('input', scheduleProfileFieldsPersist);
        document.getElementById(id)?.addEventListener('change', scheduleProfileFieldsPersist);
    }

    document.getElementById('profile-pass-new')?.addEventListener('input', () => {
        syncProfilePassHint();
        schedulePasswordPersist();
    });
    document.getElementById('profile-pass-confirm')?.addEventListener('input', () => {
        syncProfilePassHint();
        schedulePasswordPersist();
    });
}
