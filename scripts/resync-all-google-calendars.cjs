#!/usr/bin/env node
/**
 * Resynchronise l’agenda principal + tous les agendas pool assignés à un utilisateur.
 * Usage (racine Planning) : node scripts/resync-all-google-calendars.cjs
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REF = fs.readFileSync(path.join(ROOT, 'supabase/project-ref'), 'utf8').trim();
const CONFIG = fs.readFileSync(path.join(ROOT, 'js/config/planning.config.js'), 'utf8');
const bridgeMatch = CONFIG.match(/calendarBridgeUrl:\s*'([^']+)'/);
const anonMatch = CONFIG.match(/supabaseAnonKey:\s*'([^']+)'/);
const mainMatch = CONFIG.match(/mainGoogleCalendarId:\s*'([^']+)'/);
const mainLabelMatch = CONFIG.match(/mainGoogleCalendarLabel:\s*'([^']+)'/);
const BRIDGE_URL = bridgeMatch?.[1] || `https://${REF}.supabase.co/functions/v1/calendar-bridge`;
const ANON_KEY = anonMatch?.[1] || '';
const MAIN_CAL = (mainMatch?.[1] || '').trim();
const MAIN_LABEL = (mainLabelMatch?.[1] || '').trim() || 'Planning principal';

function serviceRoleKey() {
    if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
        return process.env.SUPABASE_SERVICE_ROLE_KEY.trim();
    }
    const raw = execSync(`npx supabase projects api-keys --project-ref ${REF} -o json`, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024
    });
    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    if (jsonStart < 0 || jsonEnd < jsonStart) {
        throw new Error('Impossible de lire la clé service_role.');
    }
    const keys = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    const row = keys.find((k) => k.id === 'service_role' && k.api_key);
    if (!row?.api_key) throw new Error('Clé service_role introuvable.');
    return row.api_key;
}

function listAssignedPoolCalendars() {
    const raw = execSync(
        `npx supabase db query --linked "select label, google_calendar_id from google_calendar_pool where assigned_user_id is not null and google_calendar_id is not null order by label" -o json --agent=no`,
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    if (jsonStart < 0 || jsonEnd < jsonStart) return [];
    return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
}

async function resyncCalendar(serviceKey, googleCalendarId, label) {
    const res = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: ANON_KEY,
            Authorization: `Bearer ${serviceKey}`
        },
        body: JSON.stringify({ action: 'resync_calendar', googleCalendarId })
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text };
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
    }
    return { label, googleCalendarId, ...(data || {}) };
}

function normCalKey(id) {
    return String(id || '')
        .trim()
        .toLowerCase();
}

async function main() {
    if (!ANON_KEY) throw new Error('supabaseAnonKey introuvable dans planning.config.js');
    const serviceKey = serviceRoleKey();
    /** @type {{ label: string, googleCalendarId: string }[]} */
    const targets = [];
    if (MAIN_CAL) {
        targets.push({ label: MAIN_LABEL, googleCalendarId: MAIN_CAL });
    }
    for (const row of listAssignedPoolCalendars()) {
        const gid = String(row.google_calendar_id || '').trim();
        const lab = String(row.label || '').trim() || gid.slice(0, 24);
        if (!gid) continue;
        if (targets.some((t) => normCalKey(t.googleCalendarId) === normCalKey(gid))) continue;
        targets.push({ label: lab, googleCalendarId: gid });
    }
    if (!targets.length) {
        console.log('Aucun agenda à resynchroniser.');
        return;
    }
    console.log(`Resync de ${targets.length} agenda(s)…`);
    const summary = [];
    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        console.log(`[${i + 1}/${targets.length}] ${t.label} (${t.googleCalendarId})…`);
        try {
            const r = await resyncCalendar(serviceKey, t.googleCalendarId, t.label);
            const errs = Array.isArray(r.errors) ? r.errors : [];
            summary.push({
                label: t.label,
                upserted: r.upserted ?? 0,
                removed: r.removed ?? 0,
                ok: r.ok !== false && errs.length === 0,
                errors: errs.slice(0, 3)
            });
            console.log(
                `  → ${r.upserted ?? 0} mis à jour, ${r.removed ?? 0} retiré(s)` +
                    (errs.length ? `, ${errs.length} avertissement(s)` : '')
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary.push({ label: t.label, ok: false, error: msg });
            console.error(`  → ÉCHEC : ${msg}`);
        }
    }
    const failed = summary.filter((s) => s.ok === false || s.error);
    console.log('\n--- Bilan ---');
    for (const s of summary) {
        if (s.error) {
            console.log(`✗ ${s.label} : ${s.error}`);
        } else if (s.errors?.length) {
            console.log(`△ ${s.label} : ${s.upserted}↑ ${s.removed}↓ — ${s.errors[0]}`);
        } else {
            console.log(`✓ ${s.label} : ${s.upserted} créneau(x) resynchronisé(s), ${s.removed} retiré(s)`);
        }
    }
    if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
