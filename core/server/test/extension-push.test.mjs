import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * What a server half pushes to the pages that listen to its topics, on any page: one stream for the page, a
 * topic asked for on it, and the extension saying who may. The module of each extension here records what it is
 * asked in `globalThis.pushed`.
 */
const home = inProcessHome("extension-push-");
const pkg = path.join(home, "packages");
mkdirSync(pkg, { recursive: true });

let revs = 0;
/** A server half written anew under this name: `body` is its default export's own. */
function write(name, body) {
  const dir = path.join(pkg, name.replace("/", "-"));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, `export default async function (portal) {\n${body}\n}\n`);
  const stat = statSync(file);
  return { name, version: "1.0.0", file, rev: `${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}-${++revs}` };
}

const NOTES = "pithagoras-notes";
const OTHER = "pithagoras-other";

/**
 * Notes lets a page listen to "all" and to "folder/<name>" for a folder it has, to nothing else; it tells a page where
 * things stand as it begins to, and undoes what it did for the page when the page stops. "slow/<ms>" decides after a while.
 */
const NOTES_MODULE = `
  const state = (globalThis.pushed ??= { listening: new Set(), left: 0, asked: [] });
  const folders = new Set(["site", "docs"]);
  state.portal = portal;
  portal.onListen(async (topic, page) => {
    state.asked.push(topic);
    if (topic === "boom") throw new Error("it failed");
    if (topic === "never") return new Promise(() => {});
    if (topic.startsWith("slowno/")) {
      await new Promise((resolve) => setTimeout(resolve, Number(topic.slice(7))));
      return false;
    }
    const slow = /^slow\\/(\\d+)$/.exec(topic);
    if (slow) {
      await new Promise((resolve) => setTimeout(resolve, Number(slow[1])));
      page.send({ first: topic });
      return;
    }
    const folder = /^folder\\/(.+)$/.exec(topic)?.[1];
    if (topic !== "all" && !(folder && folders.has(folder))) return false;
    state.listening.add(topic);
    page.send({ standing: topic });
    return () => {
      state.listening.delete(topic);
      state.left++;
    };
  });
  return () => { state.stopped = (state.stopped ?? 0) + 1; };
`;
// Another package, with a topic of the same name and no rule of its own.
const OTHER_MODULE = `
  (globalThis.pushedOther ??= {}).portal = portal;
`;

const { default: express } = await import("express");
const host = await import("../dist/extension-host.js");
const { pushesRouter } = await import("../dist/api/pushes.js");
const hub = await import("../dist/extension-push.js");
const { openStreams } = hub;
const { bindLogin, sweep } = await import("../dist/login-streams.js");

let hash = "one";
bindLogin({ hash: () => hash });

const app = express();
app.use(express.json());
app.use("/api", pushesRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(async () => {
  await host.stopServerHalves();
  server.closeAllConnections();
  server.close();
});
const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;

await host.syncServerHalves([write(NOTES, NOTES_MODULE), write(OTHER, OTHER_MODULE)]);

/** A page's stream: what it has been sent, by event, with a way to wait for more. */
async function page() {
  const abort = new AbortController();
  const res = await fetch(at("/api/pushes"), { signal: abort.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  const waiting = [];
  let closed = false;
  const reading = (async () => {
    let text = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        text += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = text.indexOf("\n\n")) !== -1) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) events.push({ name, data: data ? JSON.parse(data) : null });
          for (const wake of waiting.splice(0)) wake();
        }
      }
    } catch {
      // Cut off by the page.
    }
    closed = true;
    for (const wake of waiting.splice(0)) wake();
  })();
  const until = async (done, what) => {
    for (let i = 0; i < 200 && !done(); i++) await Promise.race([new Promise((resolve) => waiting.push(resolve)), new Promise((resolve) => setTimeout(resolve, 25))]);
    assert.ok(done(), `${what}; got ${JSON.stringify(events)}`);
  };
  await until(() => events.some((e) => e.name === "ready"), "the stream says which it is");
  const id = events.find((e) => e.name === "ready").data.stream;
  const post = (route, body) => fetch(at(`/api/pushes/${id}/${route}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    id,
    events,
    until,
    /** What the page has heard of pushes, in order, as `[topic, data]`. */
    heard: () => events.filter((e) => e.name === "push").map((e) => [e.data.extension === NOTES ? e.data.topic : `${e.data.extension}:${e.data.topic}`, e.data.data]),
    listen: (topic, extension = NOTES, token) => post("listen", { extension, topic, token }),
    leave: (topic, extension = NOTES, token) => post("leave", { extension, topic, token }),
    get closed() { return closed; },
    close: async () => {
      abort.abort();
      await reading;
    },
  };
}

test("a page is told where things stand as it begins to listen, then each push to the topic, and nothing of another topic", async () => {
  const { portal } = globalThis.pushed;
  const a = await page();
  assert.equal((await a.listen("all")).status, 200);
  portal.push("all", { n: 1 });
  portal.push("folder/site", { elsewhere: true });
  portal.push("all", { n: 2 });
  await a.until(() => a.heard().length === 3, "three things heard");
  assert.deepEqual(a.heard(), [["all", { standing: "all" }], ["all", { n: 1 }], ["all", { n: 2 }]]);
  await a.close();
});

test("the topics are the extension's own: another package's page hears nothing of them, and cannot send under its name", async () => {
  const { portal } = globalThis.pushed;
  const a = await page();
  // Another package has no rule: any page may listen, to a topic that has the same name as Notes' and is not Notes'.
  assert.equal((await a.listen("all", OTHER)).status, 200);
  assert.equal((await a.listen("all")).status, 200);
  portal.push("all", "from notes");
  globalThis.pushedOther.portal.push("all", "from the other");
  await a.until(() => a.heard().length === 3, "each topic's own");
  assert.deepEqual(a.heard(), [["all", { standing: "all" }], ["all", "from notes"], ["pithagoras-other:all", "from the other"]]);
  // The page that listened to the other package's topic only hears the other's.
  const b = await page();
  assert.equal((await b.listen("all", OTHER)).status, 200);
  portal.push("all", "again from notes");
  globalThis.pushedOther.portal.push("all", "again from the other");
  await b.until(() => b.heard().length === 1, "only the other's");
  assert.deepEqual(b.heard(), [["pithagoras-other:all", "again from the other"]]);
  await a.close();
  await b.close();
});

test("a page is refused a topic the extension does not allow, and hears nothing of it, not even what is pushed while it is decided", async () => {
  const { portal } = globalThis.pushed;
  const a = await page();
  const refused = await a.listen("folder/secret");
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "refused");
  assert.equal((await a.listen("boom")).status, 403, "a handler that throws refuses");
  portal.push("folder/secret", "hidden");
  // A topic whose handler is slow: what is pushed in the meantime is held, then delivered to the one let in after what it was told first.
  const slow = a.listen("slow/150");
  await new Promise((resolve) => setTimeout(resolve, 30));
  portal.push("slow/150", "while deciding");
  assert.equal((await slow).status, 200);
  portal.push("slow/150", "after");
  await a.until(() => a.heard().length === 3, "the slow topic's three things");
  assert.deepEqual(a.heard(), [["slow/150", { first: "slow/150" }], ["slow/150", "while deciding"], ["slow/150", "after"]]);
  assert.ok(!a.heard().some(([topic]) => topic === "folder/secret"), "the refused topic was not sent");
  // Refused after a while: what was pushed to it meanwhile is not sent either.
  const late = a.listen("slowno/100");
  await new Promise((resolve) => setTimeout(resolve, 20));
  portal.push("slowno/100", "while deciding, then refused");
  assert.equal((await late).status, 403);
  portal.push("slowno/100", "after");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!a.heard().some(([topic]) => topic === "slowno/100"), "a topic that was refused after a while sent nothing, not even what was held for it");
  await a.close();
});

test("a page that leaves while its topic is still being decided hears nothing more of it", async () => {
  const { portal } = globalThis.pushed;
  const a = await page();
  const pending = a.listen("slow/100");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await a.leave("slow/100");
  portal.push("slow/100", "after leaving");
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(a.heard().filter(([, data]) => data === "after leaving"), [], "a page that left hears nothing more");
  await a.close();
});

test("what an extension started for a page is undone when the page leaves, when its stream closes, and when its login ends", async () => {
  const state = globalThis.pushed;
  const before = state.left;
  const a = await page();
  assert.equal((await a.listen("folder/site")).status, 200);
  assert.ok(state.listening.has("folder/site"));
  assert.equal((await a.listen("folder/site")).status, 200, "asked twice is one");
  assert.equal(state.left, before);
  await a.leave("folder/site");
  assert.equal(state.left, before + 1);
  assert.ok(!state.listening.has("folder/site"));
  assert.equal((await a.listen("folder/docs")).status, 200);
  await a.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.left, before + 2, "a closed stream undoes what its topics started");
  // A login that ends: the stream is ended by the portal, and the same happens.
  const b = await page();
  assert.equal((await b.listen("all")).status, 200);
  hash = "two";
  sweep();
  await b.until(() => b.closed, "the stream is ended");
  hash = "one";
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.left, before + 3);
  assert.equal(openStreams(), 0);
});

test("a page that stops listening and begins again, whose requests come in the other order, keeps the listening it began", async () => {
  const state = globalThis.pushed;
  const { portal } = state;
  const a = await page();
  const asked = state.asked.length;
  const left = state.left;
  assert.equal((await a.listen("folder/site", NOTES, "1")).status, 200);
  // The second ask is handled before the leave of the first: the listening is the new one, told where things stand again.
  assert.equal((await a.listen("folder/site", NOTES, "2")).status, 200);
  assert.equal(state.asked.length, asked + 2, "its handler decided again");
  assert.equal(state.left, left + 1, "what the first listening started is undone");
  assert.ok(state.listening.has("folder/site"), "and what the second started is going");
  await a.until(() => a.heard().filter(([, data]) => data?.standing === "folder/site").length === 2, "told where things stand twice");
  await a.leave("folder/site", NOTES, "1");
  assert.equal(state.left, left + 1, "the leave of the first does not end the second");
  portal.push("folder/site", "after the late leave");
  await a.until(() => a.heard().some(([, data]) => data === "after the late leave"), "the page still hears the topic");
  // The leave that is its own ends it.
  await a.leave("folder/site", NOTES, "2");
  assert.equal(state.left, left + 2);
  portal.push("folder/site", "after leaving");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(a.heard().filter(([, data]) => data === "after leaving"), []);
  // Without a name, as before: a leave ends the listening.
  assert.equal((await a.listen("folder/docs")).status, 200);
  assert.equal((await a.leave("folder/docs")).status, 200);
  assert.ok(!state.listening.has("folder/docs"));
  assert.equal((await a.listen("all", NOTES, "x".repeat(65))).status, 400, "a name is short");
  assert.equal((await a.leave("all", NOTES, "")).status, 400);
  await a.close();
});

test("what a handler starts after the time it has is undone as soon as it says so, for the page was let go of", async (t) => {
  const quiet = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = { stopped: 0 };
  let answer;
  hub.addGate("pithagoras-slow", () => new Promise((resolve) => (answer = resolve)));
  const opened = hub.openStream(() => {});
  const asking = hub.listen(opened.id, "pithagoras-slow", "t");
  t.mock.timers.tick(10_001);
  assert.equal(await asking, "refused", "a handler that takes over ten seconds refuses");
  answer(() => slow.stopped++);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slow.stopped, 1, "its cleanup is called, though it came late");
  opened.close();
  hub.dropExtension("pithagoras-slow");
  assert.equal(slow.stopped, 1, "once");
  // (Node itself may say, through the same console, that mock timers are experimental.)
  assert.equal(quiet.mock.calls.filter((call) => String(call.arguments[0]).startsWith("[extension")).length, 1, "only the slowness is told");
});

test("a stream that is not open, and what is not a topic of a running extension, is turned away", async () => {
  const a = await page();
  const gone = await fetch(at("/api/pushes/nothing/listen"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extension: NOTES, topic: "all" }) });
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).code, "no-stream");
  assert.equal((await a.listen("all", "pithagoras-not-installed")).status, 404);
  assert.equal((await a.listen("")).status, 400);
  assert.equal((await a.listen("x".repeat(201))).status, 400);
  assert.equal((await a.listen("new\nline")).status, 400);
  assert.equal((await a.listen("all", "../../etc")).status, 400);
  assert.equal((await fetch(at(`/api/pushes/${a.id}/listen`), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  const { portal } = globalThis.pushed;
  assert.throws(() => portal.push("", 1), TypeError);
  assert.throws(() => portal.push("x".repeat(201), 1), TypeError);
  assert.throws(() => portal.onListen("not a function"), TypeError);
  await a.close();
});

test("a page that listens to more topics than it may is turned away", async () => {
  const a = await page();
  let status;
  // Distinct topics of Other's, which has no rule: the five hundred and first is too many.
  for (let i = 0; i < 501; i++) status = (await a.listen(`t${i}`, OTHER)).status;
  assert.equal(status, 429);
  await a.close();
});

test("an extension that stops is dropped from the pages that listened to it: it is undone and the page is told, to ask again once it is back", async () => {
  const state = globalThis.pushed;
  const before = state.left;
  const a = await page();
  assert.equal((await a.listen("folder/docs")).status, 200);
  await host.syncServerHalves([write(OTHER, OTHER_MODULE)]);
  await a.until(() => a.events.some((e) => e.name === "lost"), "told the topic is lost");
  assert.deepEqual(a.events.find((e) => e.name === "lost").data, { extension: NOTES, topic: "folder/docs" });
  assert.equal(state.left, before + 1);
  // Not running: the ask is turned away until it is.
  const none = await a.listen("folder/docs");
  assert.equal(none.status, 404);
  assert.equal((await none.json()).code, "not-running");
  // Started again, it decides again, and the page is told where things stand again.
  await host.syncServerHalves([write(NOTES, NOTES_MODULE), write(OTHER, OTHER_MODULE)]);
  assert.equal((await a.listen("folder/docs")).status, 200);
  await a.until(() => a.heard().filter(([, data]) => data?.standing === "folder/docs").length === 2, "told where things stand again");
  await a.close();
});
