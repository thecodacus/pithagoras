import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { registerServiceWorker } from "../core/web/src/register-sw.ts";

const pub = new URL("../core/web/public/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, pub));

/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (buf: Buffer) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test("the manifest makes the portal installable", () => {
  const manifest = JSON.parse(read("manifest.webmanifest").toString());
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  for (const icon of manifest.icons) {
    const [w, h] = pngSize(read(icon.src.slice(1)));
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  assert.ok(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable"));
});

test("the page links the manifest", () => {
  const html = readFileSync(new URL("../core/web/index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest"/);
});

/** A window whose `load` can be fired, and what the worker registration saw. */
function fakeWindow(withWorkers = true) {
  const registered: string[] = [];
  const onLoad: (() => void)[] = [];
  const navigator = withWorkers ? { serviceWorker: { register: async (url: string) => void registered.push(url) } } : {};
  const win = { navigator, addEventListener: (type: string, f: () => void) => type === "load" && onLoad.push(f) };
  return { win: win as unknown as Window, registered, load: () => onLoad.forEach((f) => f()) };
}

test("a build registers the worker once the page has loaded", () => {
  const { win, registered, load } = fakeWindow();
  registerServiceWorker(true, win);
  assert.deepEqual(registered, []);
  load();
  assert.deepEqual(registered, ["/sw.js"]);
});

test("the dev server and browsers without workers register nothing", () => {
  const dev = fakeWindow();
  registerServiceWorker(false, dev.win);
  dev.load();
  assert.deepEqual(dev.registered, []);
  const none = fakeWindow(false);
  registerServiceWorker(true, none.win);
  none.load();
  assert.deepEqual(none.registered, []);
});

test("every copy of the canvas colour matches --canvas in index.css", () => {
  const css = readFileSync(new URL("../core/web/src/index.css", import.meta.url), "utf8");
  const canvas = (theme: string) => {
    const block = css.slice(css.indexOf(`[data-theme="${theme}"]`));
    const [r, g, b] = block.match(/--canvas:\s*(\d+) (\d+) (\d+)/)!.slice(1).map(Number);
    return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
  };
  const html = readFileSync(new URL("../core/web/index.html", import.meta.url), "utf8");
  assert.equal(html.match(/<meta name="theme-color" content="([^"]+)"/)![1], canvas("dark"));
  assert.equal(JSON.parse(read("manifest.webmanifest").toString()).background_color, canvas("dark"));
  assert.match(read("theme-init.js").toString(), new RegExp(`meta\\.content = "${canvas("light")}"`));
});

const ORIGIN = "https://portal.test";
const html = (...assets: string[]) =>
  new Response(`<div id="root"></div><script type="module" src="${assets[0]}"></script>${assets.slice(1).map((a) => `<link rel="stylesheet" href="${a}">`).join("")}`, {
    headers: { "content-type": "text/html" },
  });
const js = (body = "export {}") => new Response(body, { headers: { "content-type": "text/javascript" } });
const png = () => new Response("png", { headers: { "content-type": "image/png" } });

type Route = () => Response | Promise<Response>;

/** Every reading is later than the last, so which asset was used last is never a tie. */
let clock = 0;
const Date = { now: () => ++clock };

/**
 * The worker, against caches kept in memory and a network answered by
 * `routes` — where a path missing from it is the server being unreachable.
 * Pass another worker's `stores` for a later life of the same one.
 */
function worker(routes: Record<string, Route> = {}, stores = new Map<string, Map<string, Response>>()) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const key = (r: string | Request) => new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (r: string | Request) => store.get(key(r))?.clone(),
      put: async (r: string | Request, response: Response) => void store.set(key(r), response),
      delete: async (r: string | Request) => store.delete(key(r)),
      keys: async () => [...store.keys()].map((path) => new Request(ORIGIN + path)),
      addAll: async (paths: string[]) => {
        for (const path of paths) store.set(path, await network(path));
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: string | Request, { cacheName }: { cacheName: string }) => (await open(cacheName)).match(r),
  };
  const fetched: string[] = [];
  const network = async (r: string | Request) => {
    const path = key(r);
    fetched.push(path);
    const route = routes[path];
    if (!route) throw new TypeError("Failed to fetch");
    return route();
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  runInNewContext(read("sw.js").toString(), { self, URL, caches, fetch: network, Response, Promise, Date });

  /** Runs a lifecycle event to the end of everything it waits on. */
  async function settle(pending: Promise<unknown>[]) {
    for (let done = 0; done < pending.length; done = pending.length) await Promise.all(pending.slice(done));
  }
  return {
    stores,
    fetched,
    routes,
    stored: (name: string) => [...(stores.get(name)?.keys() ?? [])].sort(),
    async lifecycle(type: "install" | "activate") {
      const pending: Promise<unknown>[] = [];
      listeners[type]({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await settle(pending);
    },
    /** The worker's answer, or undefined when it leaves the request to the browser. */
    async get(path: string, init: { method?: string; mode?: string; origin?: string } = {}) {
      const pending: Promise<unknown>[] = [];
      let answer: Promise<Response> | undefined;
      const request = { url: (init.origin ?? ORIGIN) + path, method: init.method ?? "GET", mode: init.mode ?? "cors" };
      listeners.fetch({
        request,
        respondWith: (p: Promise<Response>) => (answer = p),
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      });
      if (!answer) return undefined;
      const response = await answer;
      await settle(pending);
      return response;
    },
  };
}

const installed = async (routes: Record<string, Route>) => {
  const sw = worker(routes);
  await sw.lifecycle("install");
  await sw.lifecycle("activate");
  return sw;
};
const deployed = {
  "/": () => html("/assets/index-a.js", "/assets/index-a.css"),
  "/assets/index-a.js": () => js(),
  "/assets/index-a.css": () => new Response("", { headers: { "content-type": "text/css" } }),
  "/theme-init.js": () => js("theme 1"),
  "/manifest.webmanifest": () => new Response("{}"),
  "/icon-192.png": png,
  "/favicon-32.png": png,
};

test("the worker leaves the live parts of the portal to the server", async () => {
  const sw = worker();
  assert.equal(await sw.get("/api/sessions"), undefined);
  assert.equal(await sw.get("/api/sessions/x/events", { mode: "navigate" }), undefined);
  assert.equal(await sw.get("/api/x/pithagoras-browser/ui/", { mode: "navigate" }), undefined);
  assert.equal(await sw.get("/voice-assets/silero_vad_v5.onnx"), undefined);
  assert.equal(await sw.get("/assets/index-abc.js", { method: "POST" }), undefined);
  assert.equal(await sw.get("/assets/index-abc.js", { origin: "https://elsewhere.test" }), undefined);
});

test("installing keeps the page and the assets it loads, which the first visit fetched before the worker was there", async () => {
  const sw = await installed({ ...deployed });
  assert.deepEqual(sw.stored("pithagoras-assets-v1"), ["/assets/index-a.css", "/assets/index-a.js"]);
  for (const path of Object.keys(deployed)) delete (sw.routes as Record<string, Route>)[path];
  // Offline: the page and its assets still open.
  assert.match(await (await sw.get("/s/abc", { mode: "navigate" }))!.text(), /index-a\.js/);
  assert.equal((await sw.get("/assets/index-a.js"))!.status, 200);
});

test("a failing server behind a proxy opens the kept page rather than the proxy's error", async () => {
  const sw = await installed({ ...deployed });
  sw.routes["/"] = () => new Response("Bad Gateway", { status: 502 });
  const page = await sw.get("/sessions", { mode: "navigate" });
  assert.equal(page!.status, 200);
  assert.match(await page!.text(), /index-a\.js/);
});

test("the page the server sends for a missing asset is never kept as that asset", async () => {
  const sw = await installed({ ...deployed, "/assets/gone.js": () => html("/assets/index-a.js") });
  await sw.get("/assets/gone.js");
  assert.ok(!sw.stored("pithagoras-assets-v1").includes("/assets/gone.js"));
});

test("theme-init.js is asked for fresh, so a deploy's copy runs on the next load", async () => {
  const sw = await installed({ ...deployed });
  sw.routes["/theme-init.js"] = () => js("theme 2");
  assert.equal(await (await sw.get("/theme-init.js"))!.text(), "theme 2");
  delete (sw.routes as Record<string, Route>)["/theme-init.js"];
  assert.equal(await (await sw.get("/theme-init.js"))!.text(), "theme 2");
});

test("a new deploy evicts the assets used longest ago, never the page's own", async () => {
  const routes: Record<string, Route> = { ...deployed };
  for (let i = 0; i < 205; i++) routes[`/assets/old-${i}.js`] = () => js();
  const sw = await installed(routes);
  for (let i = 0; i < 205; i++) await sw.get(`/assets/old-${i}.js`);
  // A chunk stored early but still in use, in a later worker's life.
  const later = worker(routes, sw.stores);
  await later.get("/assets/old-0.js");
  // The deploy: a new entry, which the next page load brings in.
  routes["/"] = () => html("/assets/index-b.js");
  routes["/assets/index-b.js"] = () => js();
  await later.get("/", { mode: "navigate" });
  const kept = later.stored("pithagoras-assets-v1");
  assert.equal(kept.length, 200);
  assert.ok(kept.includes("/assets/index-b.js"));
  assert.ok(kept.includes("/assets/old-0.js"));
  assert.ok(!kept.includes("/assets/old-1.js"));
});

test("a deploy whose assets do not all arrive keeps the last page, which still opens offline", async () => {
  const sw = await installed({ ...deployed });
  sw.routes["/"] = () => html("/assets/index-b.js", "/assets/index-b.css");
  sw.routes["/assets/index-b.css"] = () => new Response("", { headers: { "content-type": "text/css" } });
  // The entry never arrives: the connection drops.
  await sw.get("/", { mode: "navigate" });
  for (const path of Object.keys(sw.routes)) delete (sw.routes as Record<string, Route>)[path];
  const page = await (await sw.get("/sessions", { mode: "navigate" }))!.text();
  assert.match(page, /index-a\.js/);
  assert.equal((await sw.get("/assets/index-a.js"))!.status, 200);
});

test("a page that is not the portal's, like a login proxy's, is never kept as the shell", async () => {
  const sw = await installed({ ...deployed });
  sw.routes["/"] = () => new Response("<form>Sign in</form>", { headers: { "content-type": "text/html" } });
  await sw.get("/", { mode: "navigate" });
  delete (sw.routes as Record<string, Route>)["/"];
  assert.match(await (await sw.get("/", { mode: "navigate" }))!.text(), /index-a\.js/);
  assert.deepEqual(sw.stored("pithagoras-assets-v1"), ["/assets/index-a.css", "/assets/index-a.js"]);
});

test("the first load after a deploy downloads each asset once, though the page and the worker both want it", async () => {
  const sw = await installed({ ...deployed });
  sw.routes["/"] = () => html("/assets/index-b.js");
  // A download slow enough that both ask before either has it stored.
  sw.routes["/assets/index-b.js"] = () => new Promise((done) => setTimeout(() => done(js()), 20));
  sw.fetched.length = 0;
  await Promise.all([sw.get("/", { mode: "navigate" }), sw.get("/assets/index-b.js")]);
  assert.deepEqual(sw.fetched.filter((path) => path === "/assets/index-b.js"), ["/assets/index-b.js"]);
});
