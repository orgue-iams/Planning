/**
 * Compile le CSS Tailwind puis copie les fichiers statiques dans `_site/`
 * pour GitHub Pages (sans node_modules ni dossiers backend).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '_site');

const toCopy = ['index.html', 'sw.js', 'manifest.json', 'favicon.svg', 'css', 'js', 'components'];

function runBuild() {
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

function main() {
    runBuild();
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const name of toCopy) {
        const src = join(root, name);
        if (!existsSync(src)) {
            console.warn(`publish-site: skip missing ${name}`);
            continue;
        }
        const dest = join(outDir, name);
        cpSync(src, dest, { recursive: true });
    }
    const imgDir = join(root, 'images');
    if (existsSync(imgDir)) {
        cpSync(imgDir, join(outDir, 'images'), { recursive: true });
    }
    console.log('publish-site: ready →', outDir);
}

main();
