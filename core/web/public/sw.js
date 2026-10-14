/*
 * The portal as an installed app. It opens when the server is out of reach —
 * and then says so, as it does in a tab — from the last page the server gave
 * and the built files that page loads. Nothing the agent does is cached: /api
 * and the browser view always go to the server. Pages, and the scripts not
 * named by their content, are asked for fresh first, so a deploy is there on
 * the next load rather than the one after.
 */
const SHELL = "pithagoras-shell-v2";
const ASSETS = "pithagoras-assets-v1";
/** When each built asset was last used, so the ones no build asks for go first. */
const USED = "pithagoras-assets-used-v1";
const CACHES = [SHELL, ASSETS, USED];

/** A stale copy of these would run against a newer app. */
const FRESH_FIRST = ["/theme-init.js", "/manifest.webmanifest"];

/** About three deploys' worth; the current page's own assets are always kept. */
const MAX_ASSETS = 200;

const noop = () => undefined;
const isHtml = (response) => (response.headers.get("content-type") || "").includes("text/html");
const isPage = (response) => response.ok && isHtml(response);
// The server answers a path it does not have with the page; that is never a script.
const isAsset = (response) => response.ok && !isHtml(response);

/** The built assets a page loads before it paints: its entry, preloads and styles. */
const assetsOf = (html) => [...new Set(Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), (m) => m[1]))];

/**
 * The portal's own page, not whatever HTML came back: a login proxy or a
 * captive portal answers 200 too, and kept as the shell it would open offline
 * in the portal's place.
 */
const isShell = (html) => /<div id="root">/.test(html) && assetsOf(html).length > 0;

/** Keeps the worker alive until `work` is done. A failed write only costs a copy. */
const keep = (event, work) => event.waitUntil(Promise.resolve(work).catch(noop));

const touched = new Set();
/** Marks an asset as used, once in the worker's life. */
function touch(path) {
  if (touched.has(path)) return;
  touched.add(path);
  return caches.open(USED).then((cache) => cache.put(path, new Response(null, { headers: { "x-used": String(Date.now()) } })));
}

async function saveAsset(path, response) {
  await (await caches.open(ASSETS)).put(path, response);
  touched.delete(path);
  await touch(path);
}

const loading = new Map();
/**
 * A built asset, from the cache or else the network, and kept. The page and
 * storeShell both ask for the entry after a deploy; whoever asks second
 * shares the first one's download rather than starting another.
 */
function loadAsset(path) {
  if (!loading.has(path)) {
    const load = async () => {
      const stored = await caches.match(path, { cacheName: ASSETS });
      if (stored) {
        await touch(path)?.catch(noop);
        return stored;
      }
      const response = await fetch(path);
      if (isAsset(response)) await saveAsset(path, response.clone()).catch(noop);
      return response;
    };
    loading.set(path, load().finally(() => loading.delete(path)));
  }
  return loading.get(path).then((response) => response.clone());
}

/**
 * Keeps a page as the one every route opens with — every route is the same
 * index.html — along with what it loads. A worker registers after the first
 * page has already fetched its assets, so they are fetched again here. The
 * page replaces the kept one only once all of them are stored: a shell whose
 * entry is missing opens offline as a blank page, where the one before it
 * would have opened.
 */
async function storeShell(response) {
  const html = await response.clone().text();
  if (!isShell(html)) throw new Error("not the portal's page");
  const paths = assetsOf(html);
  await Promise.all(paths.map((path) => loadAsset(path).catch(noop)));
  const assets = await caches.open(ASSETS);
  const stored = await Promise.all(paths.map((path) => assets.match(path)));
  if (stored.some((copy) => !copy)) throw new Error("the page's assets did not all arrive");
  const shell = await caches.open(SHELL);
  const before = await shell.match("/");
  const newBuild = !before || assetsOf(await before.text()).join() !== paths.join();
  await shell.put("/", response);
  if (newBuild) await prune();
}

/**
 * Every deploy names its assets anew. The ones used longest ago go once there
 * are more than MAX_ASSETS; a chunk unchanged across deploys keeps being used,
 * so it stays however early it was stored.
 */
async function prune() {
  const [shell, assets, used] = await Promise.all([caches.open(SHELL), caches.open(ASSETS), caches.open(USED)]);
  const page = await shell.match("/");
  const needed = new Set(page ? assetsOf(await page.text()) : []);
  const ages = await Promise.all(
    (await assets.keys()).map(async (request) => {
      const path = new URL(request.url).pathname;
      const stamp = await used.match(path);
      return { path, at: needed.has(path) ? Infinity : Number(stamp?.headers.get("x-used")) || 0 };
    }),
  );
  ages.sort((a, b) => b.at - a.at);
  await Promise.all(ages.slice(MAX_ASSETS).flatMap(({ path }) => [assets.delete(path), used.delete(path)]));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll([...FRESH_FIRST, "/icon-192.png", "/favicon-32.png"]))
      .then(() => fetch("/"))
      .then((response) => {
        if (!isPage(response)) throw new Error(`/ answered ${response.status}`);
        return storeShell(response);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !CACHES.includes(key)).map((key) => caches.delete(key))))
      .then(() => prune().catch(noop))
      .then(() => self.clients.claim()),
  );
});

/**
 * The server's answer, or the copy kept under `key` when the server cannot be
 * reached or is failing — a proxy in front of a restarting portal answers 502.
 */
function freshFirst(event, request, key, store) {
  const kept = () => caches.match(key, { cacheName: SHELL });
  return fetch(request).then(
    (response) => {
      if (response.status >= 500) return kept().then((copy) => copy || response);
      if (response.ok) keep(event, store(response.clone()));
      return response;
    },
    () => kept().then((copy) => copy || Response.error()),
  );
}

/** Live, or served by the server alone: never from here. */
const passThrough = (url) =>
  url.pathname.startsWith("/api/") || url.pathname.startsWith("/browser-ui") || url.pathname.startsWith("/voice-assets/");

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || passThrough(url)) return;
  const path = url.pathname;

  if (request.mode === "navigate") {
    event.respondWith(freshFirst(event, request, "/", (response) => isPage(response) && storeShell(response)));
    return;
  }

  // Built assets are named by their content: a stored one is never stale.
  if (path.startsWith("/assets/")) {
    event.respondWith(loadAsset(path));
    return;
  }

  if (FRESH_FIRST.includes(path)) {
    event.respondWith(freshFirst(event, request, path, (response) => caches.open(SHELL).then((cache) => cache.put(path, response))));
    return;
  }

  // Icons: the stored copy now, a fresh one for next time. The copy is taken
  // before the page can start reading the response.
  if (path.endsWith(".png")) {
    const fresh = fetch(request);
    keep(
      event,
      fresh.then((response) => {
        if (!response.ok) return;
        const copy = response.clone();
        return caches.open(SHELL).then((cache) => cache.put(path, copy));
      }),
    );
    event.respondWith(caches.match(path, { cacheName: SHELL }).then((stored) => stored || fresh));
  }
});
