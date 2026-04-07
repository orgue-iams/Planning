/**
 * Supabase Edge Function : valide le JWT utilisateur, relaye le corps JSON vers la Web App Google Apps Script
 * avec un secret partagé (script property côté Google).
 *
 * Secrets (Dashboard → Project Settings → Edge Functions) :
 *   GOOGLE_BRIDGE_URL = URL de déploiement Web App Apps Script (.exec)
 *   GOOGLE_BRIDGE_SECRET = même valeur que propriété BRIDGE_SECRET dans Apps Script
 *
 * Déploiement : supabase functions deploy calendar-bridge
 * Le client envoie Authorization: Bearer <access_token> (identique aux appels Supabase).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-version'
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing Authorization' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: authHeader } }
        });

        const {
            data: { user },
            error: userErr
        } = await supabase.auth.getUser();
        if (userErr || !user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const googleUrl = Deno.env.get('GOOGLE_BRIDGE_URL');
        const bridgeSecret = Deno.env.get('GOOGLE_BRIDGE_SECRET') ?? '';
        if (!googleUrl) {
            return new Response(JSON.stringify({ error: 'GOOGLE_BRIDGE_URL not set' }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const body = await req.json();
        const payload =
            typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...body } : {};

        // Apps Script Web App : en-têtes peu fiables — le secret est ajouté ici uniquement (jamais par le navigateur).
        if (bridgeSecret) {
            payload.bridgeSecret = bridgeSecret;
        }
        payload._relayUser = user.email;

        const upstream = await fetch(googleUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const text = await upstream.text();
        let data: unknown = text;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            /* texte brut */
        }

        return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
            status: upstream.ok ? 200 : upstream.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
