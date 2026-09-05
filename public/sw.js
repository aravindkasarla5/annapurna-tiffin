/* ==========================================================================
   Sri Lakshmi Annapurna Tiffin Center - PWA Service Worker
   Safe caching strategy: Static shell & assets only.
   CRITICAL: Never cache API requests, authentication, payments, or referrals!
   ========================================================================== */

const CACHE_NAME = 'annapurna-tiffin-v116';

// Static Shell Assets to Pre-cache for Fast Loading & Offline Shell
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/jsQR.js',
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

/* ==========================================================================
   Real-Time Web Push Notification Handling (Closed PWA / Website Background Support)
   ========================================================================== */

self.addEventListener('push', (event) => {
  let title = 'Annapurna Tiffin Center';
  let options = {
    body: 'New real-time notification received',
    icon: '/images/tiffin_logo.png',
    badge: '/images/icon-192.png',
    tag: 'notif_' + Date.now(),
    vibrate: [200, 100, 200, 100, 200],
    renotify: true,
    requireInteraction: true,
    timestamp: Date.now(),
    data: { url: '/' }
  };

  if (event && event.data) {
    try {
      const payload = event.data.json();
      if (payload.title) title = payload.title;
      options.body = payload.message || payload.body || options.body;
      options.icon = payload.icon || options.icon;
      options.badge = payload.badge || options.badge;
      options.tag = payload.id || payload.tag || options.tag;
      options.data = payload;
      options.data.url = payload.action_url || payload.url || '/';
    } catch (err) {
      try {
        const rawText = event.data.text();
        if (rawText) options.body = rawText;
      } catch (e2) { }
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
      .catch((err) => console.error('[PWA SW] showNotification error:', err))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const targetUrl = notifData.action_url || notifData.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          try {
            if ('postMessage' in client) {
              client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl, data: notifData });
            }
          } catch (mErr) { }
          if ('navigate' in client && targetUrl !== '/') {
            client.navigate(targetUrl);
          }
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

