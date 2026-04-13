/**
 * Authentification Supabase (GoTrue).
 */

import {
    getSupabaseClient,
    isBackendAuthConfigured,
    getRememberMePreference,
    setRememberMePreference,
    purgeSupabaseKeysFromStorage,
    isInvalidRefreshTokenError,
    clearCorruptedLocalAuthSession
} from './supabase-client.js';
import { showToast } from '../utils/toast.js';

export { isBackendAuthConfigured, getRememberMePreference } from './supabase-client.js';
import { fetchAppUserFromSession } from './supabase-auth.js';

export const PASSWORD_MIN_LENGTH = 6;

const MIN_PASS_LEN = PASSWORD_MIN_LENGTH;

/** Fenêtre pour finaliser le nouveau mot de passe après ouverture du lien (session côté client, pas le jeton e-mail). */
const RECOVERY_PENDING_TTL_MS = 30 * 60 * 1000;

const RECOVERY_PENDING_KEY = 'planning_supabase_recovery_until_ms';

function recoveryDeadlineFromNow() {
    return String(Date.now() + RECOVERY_PENDING_TTL_MS);
}

export function markSupabasePasswordRecoveryPending() {
    try {
        sessionStorage.setItem(RECOVERY_PENDING_KEY, recoveryDeadlineFromNow());
    } catch {
        /* quota / navigation privée */
    }
}

export function clearSupabasePasswordRecoveryPending() {
    try {
        sessionStorage.removeItem(RECOVERY_PENDING_KEY);
    } catch {
        /* ignore */
    }
}

/** Réinitialisation en cours : lien déjà consommé, mot de passe pas encore enregistré (fenêtre 30 min). */
export function isSupabasePasswordRecoveryPending() {
    try {
        const raw = sessionStorage.getItem(RECOVERY_PENDING_KEY);
        if (!raw) return false;
        const until = Number.parseInt(raw, 10);
        if (!Number.isFinite(until) || Date.now() > until) {
            sessionStorage.removeItem(RECOVERY_PENDING_KEY);
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

/** Lignes affichées dans la modale « changement de mot de passe ». */
export const PASSWORD_POLICY_LINES = [
    `Longueur minimale : ${MIN_PASS_LEN} caractères.`,
    'Le nouveau mot de passe et la confirmation doivent être identiques.',
    'Évitez un mot de passe trop simple ou déjà utilisé ailleurs (recommandation).'
];

export function isPrivilegedUser(user) {
    return !!(user && (user.role === 'admin' || user.role === 'prof'));
}

/** Compte enseignant (seuls les profs voient le libellé semaine A/B personnel sur le planning). */
export function isProf(user) {
    return !!(user && user.role === 'prof');
}

export function isAdmin(user) {
    return !!(user && user.role === 'admin');
}

export function roleLabelFr(role) {
    const m = { admin: 'Admin', prof: 'Prof', eleve: 'Élève' };
    return m[role] || role || '';
}

export function setPasswordModalMode(isTokenReset) {
    const group = document.getElementById('group-old-pass');
    if (group) {
        group.classList.toggle('hidden', !!isTokenReset);
    }
    const hint = document.getElementById('recovery-hint');
    if (hint) {
        hint.classList.toggle('hidden', !isTokenReset);
    }
}

/**
 * @param {boolean} [rememberMe] défaut true : session conservée après fermeture du navigateur / PWA (localStorage).
 * @returns {Promise<{ success: boolean, user?: { name: string, email: string, role: string, id?: string } }>}
 */
export async function login(email, pass, rememberMe = true) {
    if (!isBackendAuthConfigured()) {
        showToast('Configuration Supabase absente : renseignez supabaseUrl et supabaseAnonKey dans planning.config.js.', 'error');
        return { success: false };
    }
    const id = String(email ?? '').trim().toLowerCase();
    if (!id) {
        showToast('Veuillez renseigner votre email.', 'error');
        return { success: false };
    }
    const remember = rememberMe !== false;

    setRememberMePreference(remember);
    purgeSupabaseKeysFromStorage(remember ? sessionStorage : localStorage);
    const supabase = getSupabaseClient();
    if (!supabase) {
        showToast('Configuration Supabase invalide.', 'error');
        return { success: false };
    }
    try {
        await supabase.auth.signOut({ scope: 'local' });
    } catch {
        /* session absente ou stockage restreint */
    }
    const { data, error } = await supabase.auth.signInWithPassword({
        email: id,
        password: pass
    });
    if (error) {
        const raw = String(error.message || '').toLowerCase();
        let msg = error.message || 'Identifiants invalides.';
        if (raw.includes('missing email') || raw.includes('missing phone')) {
            msg = 'Veuillez renseigner votre email.';
        } else if (
            raw.includes('invalid login credentials') ||
            raw.includes('invalid_credentials') ||
            raw.includes('invalid email or password')
        ) {
            msg = 'Email ou mot de passe incorrect.';
        }
        showToast(msg, 'error');
        return { success: false };
    }
    const user = await fetchAppUserFromSession(data.session);
    if (!user) {
        showToast('Session invalide.', 'error');
        return { success: false };
    }
    document.getElementById('modal_login')?.close();
    return { success: true, user };
}

/** Restaure la session au chargement. */
export async function tryRestoreSession() {
    if (!isBackendAuthConfigured()) return null;
    const supabase = getSupabaseClient();
    if (!supabase) return null;
    const {
        data: { session: sess0 },
        error: sessErr
    } = await supabase.auth.getSession();
    if (sessErr && isInvalidRefreshTokenError(sessErr)) {
        await clearCorruptedLocalAuthSession();
        return null;
    }
    let session = sess0;
    if (!session) return null;

    const now = Math.floor(Date.now() / 1000);
    const exp = typeof session.expires_at === 'number' ? session.expires_at : 0;
    const needsRefresh = !exp || exp < now + 120;
    if (needsRefresh) {
        const { data: ref, error: refErr } = await supabase.auth.refreshSession();
        if (refErr) {
            if (isInvalidRefreshTokenError(refErr)) await clearCorruptedLocalAuthSession();
            return null;
        }
        if (!ref?.session) {
            await clearCorruptedLocalAuthSession();
            return null;
        }
        session = ref.session;
    }

    return fetchAppUserFromSession(session);
}

/** JWT courant pour le pont Agenda et les Edge Functions (rafraîchi si proche de l’expiration). */
export async function getAccessToken() {
    if (!isBackendAuthConfigured()) return null;
    const supabase = getSupabaseClient();
    if (!supabase) return null;
    const {
        data: { session },
        error
    } = await supabase.auth.getSession();
    if (error) {
        if (isInvalidRefreshTokenError(error)) await clearCorruptedLocalAuthSession();
        return null;
    }
    if (!session) return null;
    const exp = session.expires_at;
    if (typeof exp === 'number') {
        const now = Math.floor(Date.now() / 1000);
        if (exp < now + 180) {
            const { data: ref, error: rerr } = await supabase.auth.refreshSession();
            if (rerr) {
                if (isInvalidRefreshTokenError(rerr)) await clearCorruptedLocalAuthSession();
                return null;
            }
            if (ref?.session?.access_token) return ref.session.access_token;
        }
    }
    return session.access_token ?? null;
}

export async function updatePassword() {
    const newPass = document.getElementById('new-pass').value;
    const confirmPass = document.getElementById('confirm-pass').value;
    const oldPassEl = document.getElementById('old-pass');
    const isTokenReset = !!document.getElementById('group-old-pass')?.classList.contains('hidden');

    if (newPass.length < MIN_PASS_LEN) {
        showToast(`Le mot de passe doit contenir au moins ${MIN_PASS_LEN} caractères.`, 'error');
        return false;
    }

    if (newPass !== confirmPass) {
        showToast('Les nouveaux mots de passe ne correspondent pas.', 'error');
        return false;
    }

    if (!isBackendAuthConfigured()) {
        showToast('Configuration Supabase requise pour modifier le mot de passe.', 'error');
        return false;
    }
    const supabase = getSupabaseClient();
    if (!supabase) return false;

    if (!isTokenReset) {
        const oldPass = oldPassEl?.value || '';
        const { data: { user } } = await supabase.auth.getUser();
        if (!user?.email) {
            showToast('Session expirée. Reconnectez-vous.', 'error');
            return false;
        }
        const check = await supabase.auth.signInWithPassword({
            email: user.email,
            password: oldPass
        });
        if (check.error) {
            showToast('Ancien mot de passe incorrect.', 'error');
            return false;
        }
    }

    const { error } = await supabase.auth.updateUser({ password: newPass });
    if (error) {
        showToast(error.message || 'Impossible de mettre à jour le mot de passe.', 'error');
        return false;
    }
    if (isTokenReset) {
        clearSupabasePasswordRecoveryPending();
    }
    showToast('Mot de passe modifié avec succès !');
    document.getElementById('modal_password').close();
    return true;
}

/**
 * Indique si l’URL actuelle ressemble au retour d’un e-mail de réinitialisation Supabase
 * (fragment #… ou redirection PKCE avec ?code=).
 */
export function hasSupabaseRecoveryInUrl() {
    if (!isBackendAuthConfigured()) return false;
    const h = window.location.hash.replace(/^#/, '');
    if (h) {
        const hp = new URLSearchParams(h);
        if (hp.get('type') === 'recovery') return true;
    }
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('type') === 'recovery') return true;
    if (sp.get('code')) return true;
    return false;
}

/** Retire hash et paramètres d’auth de l’URL après consommation par le client Supabase. */
export function stripSupabaseAuthFromUrl() {
    const u = new URL(window.location.href);
    u.hash = '';
    for (const k of ['code', 'error', 'error_description', 'type']) {
        u.searchParams.delete(k);
    }
    const qs = u.searchParams.toString();
    window.history.replaceState({}, document.title, u.pathname + (qs ? `?${qs}` : ''));
}

/**
 * À appeler tôt au boot : ouvre le flux « nouveau mot de passe » sans ancien mot de passe quand Supabase émet PASSWORD_RECOVERY.
 * @param {(session: import('https://esm.sh/@supabase/supabase-js@2.49.8').Session) => void} onRecovery
 * @returns {() => void} désinscription
 */
export function subscribeSupabasePasswordRecovery(onRecovery) {
    if (!isBackendAuthConfigured()) return () => {};
    const supabase = getSupabaseClient();
    if (!supabase) return () => {};
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY' && session) {
            onRecovery(session);
        }
    });
    return () => subscription.unsubscribe();
}

/** Session encore valide après un lien « oublié » consommé : on peut rouvrir la modale (jeton e-mail, lui, reste à usage unique). */
export async function shouldResumeSupabasePasswordRecovery() {
    if (!isBackendAuthConfigured()) return false;
    if (!isSupabasePasswordRecoveryPending()) return false;
    const supabase = getSupabaseClient();
    if (!supabase) return false;
    const {
        data: { session },
        error
    } = await supabase.auth.getSession();
    if (error && isInvalidRefreshTokenError(error)) {
        await clearCorruptedLocalAuthSession();
        clearSupabasePasswordRecoveryPending();
        return false;
    }
    if (!session) {
        clearSupabasePasswordRecoveryPending();
        return false;
    }
    return true;
}

export async function sendResetLink(email) {
    if (!isBackendAuthConfigured()) {
        showToast('Configuration Supabase requise pour la réinitialisation par e-mail.', 'error');
        return;
    }
    const addr = String(email).trim();
    if (!addr.includes('@')) {
        showToast('Email invalide', 'error');
        return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) return;
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await supabase.auth.resetPasswordForEmail(addr, { redirectTo });
    if (error) {
        showToast(error.message || 'Impossible d’envoyer le lien.', 'error');
        return;
    }
    showToast('Si cette adresse est enregistrée, un e-mail de réinitialisation a été envoyé.', 'info');
    document.getElementById('modal_forgot').close();
    document.getElementById('modal_login')?.showModal();
}

/** Réservé aux flux d’auth Supabase (fragment / code) ; pas d’autre usage. */
export function checkUrlToken() {
    /* Ancien paramètre ?token= démo supprimé. */
}

let logoutImpl = () => window.location.reload();

export function setLogoutHandler(fn) {
    if (typeof fn === 'function') logoutImpl = fn;
}

export async function logout() {
    clearSupabasePasswordRecoveryPending();
    if (isBackendAuthConfigured()) {
        await getSupabaseClient()?.auth.signOut();
    }
    logoutImpl();
}
