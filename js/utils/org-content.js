/**
 * Règles orgue + messages planifiés (Supabase) — repli localStorage si pas de backend.
 */
import { getSupabaseClient, isBackendAuthConfigured } from '../core/supabase-client.js';

/** Contenu HTML d’annonce sans texte utile après retrait des balises (ex. paragraphe Quill vide). */
function loginScheduledBodyIsEmpty(html) {
    const t = String(html ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\u00a0/g, ' ')
        .trim();
    return t.length === 0;
}

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

/** Bandeau sur la modale login (période active). */
export async function fetchActiveLoginMessage() {
    if (!isBackendAuthConfigured()) return null;
    const sb = getSupabaseClient();
    if (!sb) return null;
    const now = new Date().toISOString();
    const { data, error } = await sb
        .from('scheduled_messages')
        .select('id,body')
        .eq('channel', 'login')
        .lte('starts_at', now)
        .gte('ends_at', now)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        console.warn('[login message]', error.message);
        return null;
    }
    if (!data?.body || loginScheduledBodyIsEmpty(data.body)) return null;
    return { id: data.id, body: data.body };
}

export async function listScheduledMessagesRemote() {
    const sb = getSupabaseClient();
    if (!sb) return [];
    const { data, error } = await sb
        .from('scheduled_messages')
        .select('id,body,starts_at,ends_at,channel,created_at')
        .eq('channel', 'login')
        .order('starts_at', { ascending: false })
        .limit(50);
    if (error) {
        console.warn('[scheduled list]', error.message);
        return [];
    }
    return data ?? [];
}

export async function insertScheduledMessageRemote({ body, startsAt, endsAt }) {
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Non connecté' };
    const { data: u } = await sb.auth.getUser();
    const { error } = await sb.from('scheduled_messages').insert({
        body: String(body || '').trim(),
        starts_at: startsAt,
        ends_at: endsAt,
        channel: 'login',
        created_by: u.user?.id ?? null
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
}

/** Une seule annonce à la fois : tout remplacer par le nouveau message. Retourne la ligne insérée pour l’UI (évite affichage périmé au rechargement). */
export async function replaceLoginAnnouncementRemote({ body, startsAt, endsAt }) {
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Non connecté' };
    const { data: u } = await sb.auth.getUser();
    const { error: delErr } = await sb.from('scheduled_messages').delete().eq('channel', 'login');
    if (delErr) return { ok: false, error: delErr.message };
    const html = String(body ?? '');
    if (loginScheduledBodyIsEmpty(html)) {
        return { ok: true, row: null };
    }
    if (!startsAt || !endsAt) {
        return { ok: false, error: 'Indiquez début et fin (date + heure).' };
    }
    const { data, error } = await sb
        .from('scheduled_messages')
        .insert({
            body: html.trim(),
            starts_at: startsAt,
            ends_at: endsAt,
            channel: 'login',
            created_by: u.user?.id ?? null
        })
        .select('id,body,starts_at,ends_at')
        .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, row: data ?? null };
}

/** Dernière annonce login (pour préremplir l’éditeur) ; il n’en reste qu’une après publication. */
export async function fetchLatestLoginAnnouncementForEdit() {
    const sb = getSupabaseClient();
    if (!sb) return null;
    const { data, error } = await sb
        .from('scheduled_messages')
        .select('id,body,starts_at,ends_at')
        .eq('channel', 'login')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        console.warn('[scheduled latest]', error.message);
        return null;
    }
    return data ?? null;
}

export async function deleteScheduledMessageRemote(id) {
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Non connecté' };
    const { error } = await sb.from('scheduled_messages').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
}
