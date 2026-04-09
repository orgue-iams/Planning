'use strict';

/**
 * Déploiement local : migrations puis toutes les Edge Functions.
 * Référence projet : variable d’environnement SUPABASE_PROJECT_REF, sinon supabase/project-ref (une ligne).
 * Prérequis : `supabase login` sur la machine (et lien DB si db push l’exige).
 */

const { readFileSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const root = join(__dirname, '..');

function getProjectRef() {
    const fromEnv = process.env.SUPABASE_PROJECT_REF && String(process.env.SUPABASE_PROJECT_REF).trim();
    if (fromEnv) return fromEnv;
    const raw = readFileSync(join(root, 'supabase', 'project-ref'), 'utf8').trim();
    const line = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
    return line ? line.trim() : '';
}

function run(label, command, args) {
    console.log(`\n→ ${label}: ${command} ${args.join(' ')}\n`);
    const r = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: false,
        env: process.env
    });
    if (r.error) {
        console.error(r.error);
        process.exit(1);
    }
    if (r.status !== 0 && r.status !== null) {
        process.exit(r.status);
    }
}

const projectRef = getProjectRef();
if (!projectRef) {
    console.error('Référence projet absente : définissez SUPABASE_PROJECT_REF ou remplissez supabase/project-ref.');
    process.exit(1);
}

console.log(`Projet Supabase (ref) : ${projectRef}`);

run('Migrations (db push)', 'supabase', ['db', 'push', '--yes']);
run('Edge Functions (toutes)', 'supabase', ['functions', 'deploy', '--project-ref', projectRef, '--yes']);

console.log('\nDéploiement Supabase terminé.\n');
