/* ==========================================================================
   Sri Lakshmi Annapurna Tiffin Center - PWA Service Worker
   Safe caching strategy: Static shell & assets only.
   CRITICAL: Never cache API requests, authentication, payments, or referrals!
   ========================================================================== */

const CACHE_NAME = 'annapurna-tiffin-v2';

// Static Shell Assets to Pre-cache for Fast Loading & Offline Shell
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/manifest.json',
  '/images/tiffin_logo.png',
  '/images/hero_banner.png',
  '/images/icon-192.png',
  '/images/icon-512.png'
];

// Install Event - Precache Static App Shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[PWA SW] Pre-caching warning:', err);
      });
    })
  );
});

// Activate Event - Clean Up Old Caches & Claim Clients Immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[PWA SW] Removing old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Handle Requests Safely
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 🚨 CRITICAL RULE 1: Never intercept or cache non-GET requests or backend API routes (/api/*)
  // All API calls (Auth, Cart, Orders, Payments, PhonePe, Referrals, Profile, Settings) MUST stay live!
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return; // Pass through directly to live backend network
  }

  // 🚨 CRITICAL RULE 2: For static assets, use Network First with Cache Fallback
  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        // If network request is successful, update cache for static GET assets
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        // Network failed (Offline mode)
        const cachedResponse = await caches.match(req);
        if (cachedResponse) {
          return cachedResponse;
        }

        // If user navigates HTML page while offline, return index.html shell
        if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
          return caches.match('/index.html');
        }

        return new Response('Offline - No connection available', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'Content-Type': 'text/plain' })
        });
      })
  );
});
