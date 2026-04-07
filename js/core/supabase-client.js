/**
 * Client Supabase (ESM) — chargé uniquement si l’URL et la clé anon sont renseignées dans planning.config.js
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

/** @returns {{ supabaseUrl: string, supabaseAnonKey: string, calendarBridgeUrl: string }} */
export function getPlanningConfig() {
    const c = typeof window !== 'undefined' ? window.__PLANNING_CONFIG__ : null;
    return {
        supabaseUrl: String(c?.supabaseUrl ?? '').trim(),
        supabaseAnonKey: String(c?.supabaseAnonKey ?? '').trim(),
        calendarBridgeUrl: String(c?.calendarBridgeUrl ?? '').trim()
    };
}

export function isBackendAuthConfigured() {
    const { supabaseUrl, supabaseAnonKey } = getPlanningConfig();
    return Boolean(supabaseUrl && supabaseAnonKey);
}

/** Toujours dans localStorage : indique si la session auth doit aller en localStorage (oui) ou sessionStorage (non). */
const PLANNING_REMEMBER_ME_KEY = 'planning_auth_remember_me';

export function getRememberMePreference() {
    try {
        if (typeof window === 'undefined') return true;
        return localStorage.getItem(PLANNING_REMEMBER_ME_KEY) !== '0';
    } catch {
        return true;
    }
}

export function setRememberMePreference(remember) {
    try {
        if (typeof window === 'undefined') return;
        localStorage.setItem(PLANNING_REMEMBER_ME_KEY, remember ? '1' : '0');
    } catch {
        /* quota */
    }
}

/** Retire les jetons Supabase (`sb-*`) d’un stockage (évite une session « collée » dans l’autre bac). */
export function purgeSupabaseKeysFromStorage(storage) {
    if (!storage) return;
    try {
        const toRemove = [];
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k && k.startsWith('sb-')) toRemove.push(k);
        }
        for (const k of toRemove) storage.removeItem(k);
    } catch {
        /* */
    }
}

let _client = null;

export function resetSupabaseClient() {
    _client = null;
}

function getAuthStorageAdapter() {
    if (typeof window === 'undefined') return undefined;
    return getRememberMePreference() ? window.localStorage : window.sessionStorage;
}

/** @returns {import('https://esm.sh/@supabase/supabase-js@2.49.8').SupabaseClient | null} */
export function getSupabaseClient() {
    if (!isBackendAuthConfigured()) return null;
    if (_client) return _client;
    const { supabaseUrl, supabaseAnonKey } = getPlanningConfig();
    const storage = getAuthStorageAdapter();
    _client = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage
        }
    });
    return _client;
}

/** Client anon sans session persistante (ex. bandeau login avant connexion). */
let _anonClient = null;

export function getAnonymousSupabase() {
    if (!isBackendAuthConfigured()) return null;
    if (_anonClient) return _anonClient;
    const { supabaseUrl, supabaseAnonKey } = getPlanningConfig();
    _anonClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        }
    });
    return _anonClient;
}
