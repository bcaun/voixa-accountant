// Pescada service worker: starts the installed app quickly, shows a clear page when offline,
// and shows push notifications. Documents and API answers are never cached: they always come
// from the server, so nobody sees stale or someone else's data.
const CACHE = 'pescada-shell-v1';
const SHELL = ['/app.css', '/fonts.css', '/favicon.svg', '/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const OFFLINE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pescada</title><link rel="stylesheet" href="/app.css"></head><body class="auth"><main class="auth-card card pad">
<h1>No connection</h1><p class="sub">Pescada needs the internet to show your documents. Check the connection and try again.</p>
<a class="btn primary" href="/">Try again</a></main></body></html>`;

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|auth|webhooks|logos|calendar|bank)\//.test(url.pathname)) return; // always the network
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  // app files: the network first (they change with every update), the copy only when offline
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Pescada', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Pescada', {
    body: d.body || '', tag: d.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins.find((x) => new URL(x.url).origin === location.origin);
    if (w) { w.navigate(target).catch(() => {}); return w.focus(); }
    return self.clients.openWindow(target);
  }));
});
