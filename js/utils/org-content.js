/**
 * Règles orgue (Supabase) — repli localStorage si pas de backend.
 */
import { getSupabaseClient, isBackendAuthConfigured } from '../core/supabase-client.js';

export async function fetchOrganRulesRemote() {
    if (!isBackendAuthConfigured()) return null;
    const sb = getSupabaseClient();
    if (!sb) return null;
    const { data, error } = await sb.from('organ_rules').select('content').eq('id', 1).maybeSingle();
    if (error) {
        console.warn('[organ_rules]', error.message);
        return null;
    }
    return typeof data?.content === 'string' ? data.content : '';
}

export async function saveOrganRulesRemote(text) {
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Non connecté' };
    const { data: u } = await sb.auth.getUser();
    const { error } = await sb
        .from('organ_rules')
        .update({ content: text, updated_at: new Date().toISOString(), updated_by: u.user?.id ?? null })
        .eq('id', 1);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
}
