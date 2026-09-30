// sw.js — Yechalal Shop service worker
//
// What it does:
//   1. Lets the app show phone notifications (with the app logo) and opens the
//      app when the person taps one.
//   2. Understands "push" messages, so notifications can arrive even when the
//      app is closed (the server part is added in the next step).
//
// What it deliberately does NOT do: it does not cache the app or intercept
// network requests. Every visit loads the newest index.html straight from the
// server, so an update can never get stuck behind an old cached copy.

// Take over as soon as a new version is installed.
self.addEventListener('install', () => {
  self.skipWaiting();
});

// The page also asks for this explicitly when it finds an update.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Tap on a notification: focus the app if it is open, otherwise open it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// Push message from the server while the app is closed or in the background.
// Expected JSON: { "title": "...", "body": "...", "tag": "...", "url": "/" }
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Yechalal Shop';
  const options = {
    body: data.body || '',
    tag: data.tag || 'yc',
    renotify: true,
    icon: data.icon || '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
