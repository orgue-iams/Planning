/**
 * Authentification : mode démo (USERS locaux) ou Supabase (option 2 : prod).
 */

import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

export { isBackendAuthConfigured } from './supabase-client.js';
import { fetchAppUserFromSession } from './supabase-auth.js';

export const PASSWORD_MIN_LENGTH = 6;

const MIN_PASS_LEN = PASSWORD_MIN_LENGTH;

/** Lignes affichées dans la modale « changement de mot de passe ». */
export const PASSWORD_POLICY_LINES = [
    `Longueur minimale : ${MIN_PASS_LEN} caractères.`,
    'Le nouveau mot de passe et la confirmation doivent être identiques.',
    'Évitez un mot de passe trop simple ou déjà utilisé ailleurs (recommandation).'
];

/** Comptes démo si Supabase non configuré */
const USERS = {
    'admin@iams.fr': { pass: '1234', name: 'Nicolas M.', email: 'admin@iams.fr', role: 'admin' },
    'prof@iams.fr': { pass: '1234', name: 'Prof. Durif', email: 'prof@iams.fr', role: 'prof' },
    'eleve1@test.com': { pass: '1234', name: 'Jean (Élève 1)', email: 'eleve1@test.com', role: 'eleve' },
    'eleve2@test.com': { pass: '1234', name: 'Marie (Élève 2)', email: 'eleve2@test.com', role: 'eleve' }
};

export function isPrivilegedUser(user) {
    return !!(user && (user.role === 'admin' || user.role === 'prof'));
}

export function isAdmin(user) {
    return !!(user && user.role === 'admin');
}

export function roleLabelFr(role) {
    const m = { admin: 'Gestion (secrétariat)', prof: 'Enseignant·e', eleve: 'Élève' };
    return m[role] || role || '';
}

export function setPasswordModalMode(isTokenReset) {
    const group = document.getElementById('group-old-pass');
    if (group) {
        group.classList.toggle('hidden', !!isTokenReset);
    }
}

/**
 * @returns {Promise<{ success: boolean, user?: { name: string, email: string, role: string, id?: string } }>}
 */
export async function login(email, pass) {
    const id = String(email).trim().toLowerCase();

    if (isBackendAuthConfigured()) {
        const supabase = getSupabaseClient();
        if (!supabase) {
            alert('Configuration Supabase invalide.');
            return { success: false };
        }
        const { data, error } = await supabase.auth.signInWithPassword({
            email: id,
            password: pass
        });
        if (error) {
            alert(error.message || 'Identifiants invalides');
            return { success: false };
        }
        const user = await fetchAppUserFromSession(data.session);
        if (!user) {
            alert('Session invalide.');
            return { success: false };
        }
        document.getElementById('modal_login')?.close();
        return { success: true, user };
    }

    const row = USERS[id];
    if (row && row.pass === pass) {
        document.getElementById('modal_login')?.close();
        return {
            success: true,
            user: { name: row.name, email: row.email, role: row.role }
        };
    }
    alert('Identifiants invalides');
    return { success: false };
}

/** Restaure la session au chargement (Supabase uniquement). */
export async function tryRestoreSession() {
    if (!isBackendAuthConfigured()) return null;
    const supabase = getSupabaseClient();
    if (!supabase) return null;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    return fetchAppUserFromSession(session);
}

/** JWT courant pour le pont Agenda (Apps Script / Edge Function). */
export async function getAccessToken() {
    if (!isBackendAuthConfigured()) return null;
    const supabase = getSupabaseClient();
    if (!supabase) return null;
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
}

export async function updatePassword() {
    const newPass = document.getElementById('new-pass').value;
    const confirmPass = document.getElementById('confirm-pass').value;
    const oldPassEl = document.getElementById('old-pass');
    const isTokenReset = !!document.getElementById('group-old-pass')?.classList.contains('hidden');

    if (newPass.length < MIN_PASS_LEN) {
        alert(`Le mot de passe doit contenir au moins ${MIN_PASS_LEN} caractères.`);
        return false;
    }

    if (newPass !== confirmPass) {
        alert("Les nouveaux mots de passe ne correspondent pas.");
        return false;
    }

    if (isBackendAuthConfigured()) {
        const supabase = getSupabaseClient();
        if (!supabase) return false;

        if (!isTokenReset) {
            const oldPass = oldPassEl?.value || '';
            const { data: { user } } = await supabase.auth.getUser();
            if (!user?.email) {
                alert('Session expirée. Reconnectez-vous.');
                return false;
            }
            const check = await supabase.auth.signInWithPassword({
                email: user.email,
                password: oldPass
            });
            if (check.error) {
                alert('Ancien mot de passe incorrect.');
                return false;
            }
        }

        const { error } = await supabase.auth.updateUser({ password: newPass });
        if (error) {
            alert(error.message || 'Impossible de mettre à jour le mot de passe.');
            return false;
        }
        alert('Mot de passe modifié avec succès !');
        document.getElementById('modal_password').close();
        return true;
    }

    console.log('Succès : Mot de passe mis à jour (démo).');
    alert('Mot de passe modifié avec succès !');
    document.getElementById('modal_password').close();
    return true;
}

export async function sendResetLink(email) {
    const addr = String(email).trim();
    if (!addr.includes('@')) {
        alert('Email invalide');
        return;
    }

    if (isBackendAuthConfigured()) {
        const supabase = getSupabaseClient();
        if (!supabase) return;
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const { error } = await supabase.auth.resetPasswordForEmail(addr, { redirectTo });
        if (error) {
            alert(error.message || 'Impossible d’envoyer le lien.');
            return;
        }
        alert(`Si cette adresse est enregistrée, un e-mail de réinitialisation a été envoyé.`);
        document.getElementById('modal_forgot').close();
        document.getElementById('modal_login')?.showModal();
        return;
    }

    const token = Math.random().toString(36).substring(2, 15);
    const resetURL = `${window.location.origin}${window.location.pathname}?token=${token}`;
    console.log('Lien démo :', resetURL);
    alert(`Un mail a été envoyé à ${addr}.`);
    document.getElementById('modal_forgot').close();
    document.getElementById('modal_login')?.showModal();
}

export function checkUrlToken() {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('token')) return;

    if (isBackendAuthConfigured()) {
        return;
    }

    setTimeout(() => {
        const loginModal = document.getElementById('modal_login');
        if (loginModal) loginModal.close();
        setPasswordModalMode(true);
        document.getElementById('modal_password').showModal();
        window.history.replaceState({}, document.title, window.location.pathname);
        document.getElementById('new-pass')?.focus();
    }, 500);
}

let logoutImpl = () => window.location.reload();

export function setLogoutHandler(fn) {
    if (typeof fn === 'function') logoutImpl = fn;
}

export async function logout() {
    if (isBackendAuthConfigured()) {
        await getSupabaseClient()?.auth.signOut();
    }
    logoutImpl();
}
