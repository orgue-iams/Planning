const CACHE_NAME = 'orgue-v32';

/** Ressources locales (hors CDN) pour démarrage rapide / coquille hors-ligne */
const ASSETS = [
  './',
  './index.html',
  './favicon.svg',
  './manifest.json',
  './css/main.css',
  './css/calendar-theme.css',
  './css/events.css',
  './css/modal.css',
  './css/auth.css',
  './js/core/app.js',
  './js/core/calendar-logic.js',
  './js/core/auth-logic.js',
  './js/core/planning-roles.js',
  './js/core/supabase-client.js',
  './js/core/supabase-auth.js',
  './js/core/calendar-bridge.js',
  './js/config/planning.config.js',
  './js/config/fc-settings.js',
  './js/utils/loader.js',
  './js/utils/time-helpers.js',
  './js/utils/touch-handler.js',
  './js/utils/toast.js',
  './js/data/mock-events.js',
  './components/headers.html',
  './components/modal-login.html',
  './components/modal-reservation.html',
  './components/modal-password.html',
  './components/modal-forgot-password.html',
  './components/modal-rules.html',
  './components/modal-broadcast.html',
  './js/utils/messaging.js',
  './js/core/messages-ui.js',
  './js/utils/user-profile.js',
  './js/core/profile-labels-ui.js',
  './js/core/login-banner.js',
  './js/core/admin-api.js',
  './js/core/admin-users-ui.js',
  './js/core/announcements-ui.js',
  './js/utils/org-content.js',
  './js/utils/rich-text.js',
  './js/utils/planning-quill.js',
  './components/modal-profile-labels.html',
  './components/modal-users-admin.html',
  './components/modal-announcements.html'
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

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((res) => res || fetch(event.request))
  );
});
