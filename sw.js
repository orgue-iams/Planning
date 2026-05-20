/* Précache : voir APP_VERSION / CACHE_NAME dans js/config/app-version.js */
import { CACHE_NAME } from './js/config/app-version.js';

/** Ressources locales (hors CDN) pour démarrage rapide / coquille hors-ligne */
const ASSETS = [
  './',
  './index.html',
  './favicon.svg',
  './images/planning-bg.png',
  './manifest.json',
  './css/tailwind.generated.css',
  './css/main.css',
  './css/planning-background.css',
  './css/calendar-toolbar.css',
  './css/calendar-theme.css',
  './css/events.css',
  './css/modal.css',
  './css/planning-card-swipe.css',
  './css/directory-rules-dark.css',
  './css/auth.css',
  './css/planning-modals-theme.css',
  './js/core/app.js',
  './js/core/calendar-toolbar.js',
  './js/core/calendar-logic.js',
  './js/core/auth-logic.js',
  './js/core/planning-roles.js',
  './js/core/supabase-client.js',
  './js/core/supabase-auth.js',
  './js/core/calendar-bridge.js',
  './js/config/planning.config.js',
  './js/config/version-info.js',
  './js/config/app-version.js',
  './js/config/cache-name.js',
  './components/modal-semaines-slot-edit.html',
  './js/config/fc-settings.js',
  './js/utils/loader.js',
  './js/utils/planning-theme.js',
  './js/utils/time-helpers.js',
  './js/utils/touch-handler.js',
  './js/utils/toast.js',
  './components/headers.html',
  './components/modal-login.html',
  './components/modal-reservation.html',
  './components/modal-password.html',
  './components/modal-forgot-password.html',
  './components/modal-rules.html',
  './components/planning-app-drawer.html',
  './css/planning-drawer.css',
  './css/planning-route-page.css',
  './js/utils/planning-route-dialog.js',
  './js/core/planning-drawer-ui.js',
  './js/core/drawer-help-ui.js',
  './js/utils/template-cours-card-ui.js',
  './js/core/drawer-profile-extras-ui.js',
  './components/modal-directory-users.html',
  './js/utils/messaging.js',
  './js/core/messages-ui.js',
  './js/utils/user-profile.js',
  './js/core/login-banner.js',
  './js/core/admin-api.js',
  './js/core/admin-users-ui.js',
  './js/core/admin-clear-week.js',
  './js/core/admin-calendar-pool-ui.js',
  './js/core/session-user.js',
  './js/core/slot-notify-api.js',
  './js/core/reservation-motifs.js',
  './js/utils/org-content.js',
  './js/utils/rich-text.js',
  './js/utils/planning-quill.js',
  './components/modal-users-admin.html',
  './components/modal-calendar-pool.html',
  './components/modal-profile.html',
  './components/modal-config.html',
  './components/modal-semaines-types.html',
  './components/modal-semaines-apply.html',
  './components/modal-semaines-shift.html',
  './components/modal-fermetures.html',
  './js/core/fermetures-ui.js',
  './js/utils/planning-card-swipe.js',
  './components/modal-course-students.html',
  './components/modal-statistics.html',
  './components/modal-cours-series-scope.html',
  './js/core/course-students-picker.js',
  './js/core/cours-series-scope-ui.js',
  './js/core/statistics-ui.js',
  './js/core/planning-eleve-quota.js',
  './js/core/profile-ui.js',
  './js/core/calendar-preferences-ui.js',
  './js/core/config-ui.js',
  './js/core/semaines-types-ui.js',
  './js/core/organ-settings.js',
  './js/core/planning-viewport-fit.js',
  './js/core/template-apply-engine.js',
  './js/core/prof-slots-shift-engine.js',
  './js/core/week-cycle.js',
  './js/core/planning-courses.js',
  './js/utils/google-calendar-url.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] cache add', url, err);
          })
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/** Fichiers de version / SW uniquement (pas la navigation : risque de réponse vide). */
function isNetworkFirstRequest(url) {
  const path = url.pathname;
  return path.endsWith('cache-name.js') || path.endsWith('sw.js');
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  let response;
  try {
    response = await fetch(request);
    if (response?.ok) {
      try {
        await cache.put(request, response.clone());
      } catch (err) {
        console.warn('[SW] cache.put', request.url, err);
      }
    }
  } catch {
    response = undefined;
  }
  if (response) return response;
  const cached = (await cache.match(request)) || (await caches.match(request));
  if (cached) return cached;
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isNetworkFirstRequest(url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((res) => res || fetch(event.request))
  );
});
