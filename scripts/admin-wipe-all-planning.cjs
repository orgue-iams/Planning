#!/usr/bin/env node
/**
 * Purge complète : agendas Google (adminWipeCalendarsInRange) + tables planning_event*.
 * Usage (racine Planning) : node scripts/admin-wipe-all-planning.cjs
 * Prérequis : supabase login + link, secrets Edge Google configurés.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REF = fs.readFileSync(path.join(ROOT, 'supabase/project-ref'), 'utf8').trim();
const CONFIG = fs.readFileSync(path.join(ROOT, 'js/config/planning.config.js'), 'utf8');
const bridgeMatch = CONFIG.match(/calendarBridgeUrl:\s*'([^']+)'/);
const anonMatch = CONFIG.match(/supabaseAnonKey:\s*'([^']+)'/);
const BRIDGE_URL = bridgeMatch?.[1] || `https://${REF}.supabase.co/functions/v1/calendar-bridge`;
const ANON_KEY = anonMatch?.[1] || '';

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
        throw new Error('Impossible de lire la clé service_role (supabase projects api-keys).');
    }
    const keys = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    const row = keys.find((k) => k.id === 'service_role' && k.api_key);
    if (!row?.api_key) throw new Error('Clé service_role introuvable.');
    return row.api_key;
}

async function wipeGoogleCalendarsRange(serviceKey, timeMin, timeMax) {
    const res = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: ANON_KEY,
            Authorization: `Bearer ${serviceKey}`
        },
        body: JSON.stringify({ action: 'adminWipeCalendarsInRange', timeMin, timeMax })
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text };
    }
    if (!res.ok) {
        throw new Error(`calendar-bridge HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return data;
}

/** Tranches annuelles pour éviter WORKER_RESOURCE_LIMIT sur une seule invocation Edge. */
function* annualWipeRanges(firstYear = 2018, lastYear = 2035) {
    for (let y = firstYear; y <= lastYear; y++) {
        yield {
            timeMin: `${y}-01-01T00:00:00.000Z`,
            timeMax: `${y + 1}-01-01T00:00:00.000Z`,
            label: String(y)
        };
    }
}

async function wipeGoogleCalendarsChunked(serviceKey) {
    const deletedByCalendar = {};
    const errors = [];
    for (const { timeMin, timeMax, label } of annualWipeRanges()) {
        console.log(`[wipe] Google année ${label}…`);
        try {
            const g = await wipeGoogleCalendarsRange(serviceKey, timeMin, timeMax);
            for (const [cal, n] of Object.entries(g.deletedByCalendar || {})) {
                if (typeof n === 'number') {
                    deletedByCalendar[cal] = (deletedByCalendar[cal] || 0) + n;
                }
            }
            if (Array.isArray(g.errors) && g.errors.length) {
                errors.push(...g.errors.map((e) => `${label}: ${e}`));
            }
        } catch (e) {
            errors.push(`${label}: ${e.message || e}`);
            console.warn(`[wipe] ${label} échec — poursuite années suivantes`);
        }
    }
    return { deletedByCalendar, errors };
}

function wipeDatabase() {
    execSync(
        'npx supabase db query --linked -f supabase/manual/wipe-all-planning-events.sql -o table --agent=no',
        {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024
        }
    );
}

async function main() {
    console.log('[wipe] Projet', REF);
    const serviceKey = serviceRoleKey();
    console.log('[wipe] Google : tranches annuelles 2018→2035 (plusieurs appels Edge)…');
    const g = await wipeGoogleCalendarsChunked(serviceKey);
    const byCal = g.deletedByCalendar || {};
    let total = 0;
    for (const [cal, n] of Object.entries(byCal)) {
        console.log(`  - ${cal}: ${n} événement(s) supprimé(s)`);
        if (typeof n === 'number') total += n;
    }
    if (Array.isArray(g.errors) && g.errors.length) {
        console.warn('[wipe] Erreurs partielles Google:', g.errors);
    }
    console.log(`[wipe] Google total ≈ ${total} suppression(s)`);
    console.log('[wipe] Base : planning_event + inscriptions + miroirs + périodes absence…');
    wipeDatabase();
    const count = execSync(
        `npx supabase db query --linked -o table --agent=no "select count(*)::int as n from planning_event"`,
        { cwd: ROOT, encoding: 'utf8' }
    );
    console.log('[wipe] planning_event restants :\n', count.trim());
    console.log('[wipe] Terminé.');
}

main().catch((e) => {
    console.error('[wipe] Échec:', e.message || e);
    process.exit(1);
});
