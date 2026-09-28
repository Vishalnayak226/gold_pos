// Customer-portal-only service worker. Registered from customer.html with
// scope '/customer.html' (see js/pwaRegister.js) — never touches the admin
// desk at '/' or '/index.html'.
//
// Deliberately minimal: it only ever intercepts navigation requests, so it
// can never fight backend/server.js's existing ?v=ASSET_VERSION
// immutable-caching scheme for JS/CSS, and never risks serving a stale
// API/money response. Everything except navigations passes straight through
// to the network/browser cache untouched.

const CACHE_NAME = 'gold-savings-portal-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll([OFFLINE_URL]))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    // No clients.claim(): an already-open tab keeps its current worker until
    // it's closed and reopened, so a deploy can never hot-swap the worker
    // under a customer mid-payment.
});

self.addEventListener('fetch', (event) => {
    if (event.request.mode !== 'navigate') return;

    // Network-first. A real response from the server — including a 4xx/5xx —
    // is returned as-is and never masked. The cached offline page is shown
    // ONLY when the fetch itself fails outright (no network).
    event.respondWith(
        fetch(event.request).catch(() => caches.match(OFFLINE_URL))
    );
});
