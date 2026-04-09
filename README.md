# Planning - Build CSS and Deploy

Le projet compile Tailwind + DaisyUI en local (pas de script CDN Tailwind en prod).

## Commandes

- Build CSS : `npm run build:css`
- Build standard : `npm run build`
- Watch CSS (dev) : `npm run watch:css`
- Préparer le dossier GitHub Pages (`_site/`, avec build CSS inclus) : `npm run deploy:pages`

## Checklist avant push/deploy

1. Lancer `npm run build:css` (ou `npm run deploy:pages` pour-pages, qui enchaîne le build)
2. Vérifier que `css/tailwind.generated.css` fait partie des changements
3. Vérifier que `index.html` ne contient pas `https://cdn.tailwindcss.com`
4. Incrémenter `CACHE_NAME` dans `sw.js` si les assets changent
5. Déployer (CI : workflow **Deploy GitHub Pages** sur `main` / `master`)

## Notes

- `sw.js` met en cache `css/tailwind.generated.css`
- Après déploiement, faire un hard refresh si besoin (`Ctrl+F5`)
