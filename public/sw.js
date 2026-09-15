/* Service worker: keeps the app shell available so the home-screen icon opens
   instantly and survives a dropped connection. Network first, and every asset
   request revalidates with the server rather than trusting the browser's HTTP
   cache — a fresh deploy is picked up on the next load, never a mix of old and
   new modules. API responses are never cached: a stale balance is worse than an
   honest error. */

const VERSION = 'bf-v4';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/theme.js',
  '/js/main.js',
  '/js/api.js',
  '/js/format.js',
  '/js/ui.js',
  '/js/tour.js',
  '/js/charts.js',
  '/js/views/dashboard.js',
  '/js/views/plan.js',
  '/js/views/accounts.js',
  '/js/views/transactions.js',
  '/js/views/cashflow.js',
  '/js/views/budget.js',
  '/js/views/recurring.js',
  '/js/views/goals.js',
  '/js/views/settings.js',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  // A navigation request can't be re-issued with options; the server marks
  // the page no-cache, so it revalidates anyway.
  const network = request.mode === 'navigate' ? fetch(request) : fetch(request, { cache: 'no-cache' });
  event.respondWith(
    network
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
