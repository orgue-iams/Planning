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

let _client = null;

/** @returns {import('https://esm.sh/@supabase/supabase-js@2.49.8').SupabaseClient | null} */
export function getSupabaseClient() {
    if (!isBackendAuthConfigured()) return null;
    if (_client) return _client;
    const { supabaseUrl, supabaseAnonKey } = getPlanningConfig();
    _client = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage: typeof window !== 'undefined' ? window.localStorage : undefined
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
