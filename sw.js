// Service worker for the Task Board app.
//
// What it does:
//  - keeps a copy of the dashboard page, so the app opens quickly and still opens with no signal
//  - asks the network for the page first, so a new version you upload shows up straight away
//  - remembers the web fonts, so the app looks the same offline
//
// What it never does: touch your Calendar sync, invoices, payment links or any other live request.
// Those are not intercepted at all - they go to the network exactly as they do in the browser.
//
// To force every phone to drop its saved copy after a big change, raise the number in SHELL_CACHE.

const SHELL_CACHE = 'taskboard-shell-v1';
const FONT_CACHE = 'taskboard-fonts-v1';
const KEEP = [SHELL_CACHE, FONT_CACHE];

const ROOT = new URL('./', self.registration.scope);   // the folder the app lives in
const SHELL_URL = ROOT.href;                            // the dashboard page is saved under this one address
const ASSETS = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']
  .map(function (name) { return new URL(name, ROOT).href; });
const NETWORK_WAIT_MS = 4000;                           // on a slow connection, open the saved page after this long

// A response that came through a redirect can't be handed to a page navigation, so keep a clean copy
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function isShellPath(pathname) {
  return pathname === ROOT.pathname || pathname === ROOT.pathname + 'index.html';
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(SHELL_CACHE);
    const page = await fetch(SHELL_URL, { cache: 'reload' });
    if (!page.ok) throw new Error('The dashboard page is not available yet');
    await cache.put(SHELL_URL, await cleanResponse(page));
    // Icons and manifest are nice to have offline, but must never stop the worker from installing
    await Promise.all(ASSETS.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names
      .filter(function (n) { return n.indexOf('taskboard-') === 0 && KEEP.indexOf(n) === -1; })
      .map(function (n) { return caches.delete(n); }));
    await self.clients.claim();
  })());
});

// The dashboard page: network first. If the network is down, or slower than NETWORK_WAIT_MS, open the saved copy.
async function shellNetworkFirst(event) {
  const cache = await caches.open(SHELL_CACHE);
  const saved = await cache.match(SHELL_URL);
  const network = fetch(event.request).then(async function (res) {
    if (res.ok && !res.redirected) await cache.put(SHELL_URL, res.clone());
    return res;
  });
  if (!saved) return network;
  event.waitUntil(network.catch(function () {}));        // let a slow fetch finish and refresh the saved copy
  const timer = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, NETWORK_WAIT_MS); });
  try {
    const first = await Promise.race([network, timer]);
    // A redirect has to be passed on untouched so the browser can follow it
    if (first && (first.ok || first.type === 'opaqueredirect')) return first;
    return saved;
  } catch (err) {
    return saved;                                         // offline
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const saved = await cache.match(request, { ignoreSearch: true });
  if (saved) return saved;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(FONT_CACHE);
  const saved = await cache.match(event.request);
  const update = fetch(event.request).then(async function (res) {
    if (res.ok || res.type === 'opaque') await cache.put(event.request, res.clone());
    return res;
  });
  if (saved) {
    event.waitUntil(update.catch(function () {}));
    return saved;
  }
  return update;
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;                       // never touch anything that saves or changes data
  const url = new URL(req.url);

  // 1. The dashboard page itself
  if (req.mode === 'navigate' && url.origin === ROOT.origin && isShellPath(url.pathname)) {
    event.respondWith(shellNetworkFirst(event));
    return;
  }

  // 2. App icons and manifest
  if (url.origin === ROOT.origin && ASSETS.indexOf(url.origin + url.pathname) !== -1) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 3. Web fonts
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }

  // Everything else (Calendar sync, invoices, payment links, WhatsApp...) is left alone on purpose.
});
