# Planning - Build CSS and Deploy

Le projet compile Tailwind + DaisyUI en local (pas de script CDN Tailwind en prod).

## Documentation projet

- **[docs/README.md](./docs/README.md)** — index (spec, architecture, roadmap).
- **[docs/HANDOFF.md](./docs/HANDOFF.md)** — **reprise de session** : planning canonique Postgres + miroir Google, livré / backlog, checklist (pour un agent ou un dev qui reprend demain).

## Commandes

- Build CSS : `npm run build:css`
- Build standard : `npm run build`
- Watch CSS (dev) : `npm run watch:css`
- Serveur local : `npm run serve:local` (http://localhost:4173)
- Préparer le dossier GitHub Pages (`_site/`, avec build CSS inclus) : `npm run deploy:pages`

## Démarrage automatique dans Cursor

Le projet configure un auto-lancement du serveur local à l'ouverture du dossier dans Cursor/VS Code :

- tâche : `.vscode/tasks.json` (`Start local web server (auto)`)
- trigger auto : `.vscode/settings.json` (`task.allowAutomaticTasks`)
- script idempotent : `scripts/start-local-server.sh`

Le serveur est démarré en arrière-plan sur **http://localhost:4173** et le script évite les doublons si le port est déjà occupé.

## Checklist avant push/deploy

1. Lancer `npm run build:css` (ou `npm run deploy:pages` pour-pages, qui enchaîne le build)
2. Vérifier que `css/tailwind.generated.css` fait partie des changements
3. Vérifier que `index.html` ne contient pas `https://cdn.tailwindcss.com`
4. Incrémenter `CACHE_NAME` dans `js/config/cache-name.js` si les assets changent
5. Déployer (CI : workflow **Deploy GitHub Pages** sur `main` / `master`)

Version cache actuelle : `orgue-v171`.

## Notes

- `sw.js` met en cache `css/tailwind.generated.css`
- Après déploiement, faire un hard refresh si besoin (`Ctrl+F5`)
