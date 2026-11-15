import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, derived } from "../core/web/src/kernel/store.ts";
import { createViewport, type Query } from "../core/web/src/kernel/viewport.ts";
import { createPrefs } from "../core/web/src/kernel/prefs.ts";
import { createMe } from "../core/web/src/kernel/me.ts";
import { createSettings, PUBLIC_SETTING_KEYS } from "../core/web/src/kernel/settings.ts";
import { createModels } from "../core/web/src/kernel/models.ts";
import { createStatus } from "../core/web/src/kernel/status.ts";
import { createComposer } from "../core/web/src/kernel/composer.ts";
import { createSessions } from "../core/web/src/kernel/sessions.ts";
import { createChats } from "../core/web/src/kernel/chats.ts";
import { createDrafts } from "../core/web/src/drafts.ts";
import { createPending, type Attachment } from "../core/web/src/attachments.ts";
import { guarded, type RawStorage } from "../core/web/src/safe-storage.ts";
import { frames, polls, session, settle, streams } from "./kernel-fakes.mts";

const mapStorage = () => {
  const map = new Map<string, string>();
  const raw: RawStorage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
  return { map, safe: guarded(() => raw) };
};

test("a store tells its listeners of a change, not of a set that changes nothing", () => {
  const store = createStore({ n: 1 });
  let heard = 0;
  const stop = store.subscribe(() => heard++);
  const same = store.get();
  store.set(same);
  assert.equal(heard, 0);
  store.update((s) => ({ n: s.n + 1 }));
  assert.equal(heard, 1);
  stop();
  store.set({ n: 9 });
  assert.equal(heard, 1);
});

test("a listener that fails does not keep the others from hearing", () => {
  const store = createStore(0);
  const heard: number[] = [];
  const log = console.error;
  console.error = () => {};
  try {
    store.subscribe(() => {
      throw new Error("broken part");
    });
    store.subscribe(() => heard.push(store.get()));
    store.set(1);
  } finally {
    console.error = log;
  }
  assert.deepEqual(heard, [1]);
});

test("a derived value is the same object while what it works out says the same, and listens to its sources only while listened to", () => {
  const a = createStore(1);
  let sourced = 0;
  const d = derived<{ big: boolean }>([(l) => (sourced++, a.subscribe(l))], () => ({ big: a.get() > 5 }));
  const first = d.get();
  a.set(2);
  assert.equal(d.get(), first);
  assert.equal(sourced, 0);
  const seen: unknown[] = [];
  const stop = d.subscribe(() => seen.push(d.get()));
  assert.equal(sourced, 1);
  a.set(3);
  assert.equal(seen.length, 0);
  a.set(9);
  assert.deepEqual(seen, [{ big: true }]);
  stop();
  a.set(1);
  assert.equal(seen.length, 1);
});

/** A window the test resizes. */
function window_(matches: boolean) {
  const q = { matches, listeners: new Set<() => void>(), addEventListener: (_: "change", l: () => void) => void q.listeners.add(l), removeEventListener: (_: "change", l: () => void) => void q.listeners.delete(l) };
  return { q: q as Query & { matches: boolean; listeners: Set<() => void> }, resize: (m: boolean) => ((q.matches = m), q.listeners.forEach((l) => l())) };
}

test("the viewport is a phone's or a desk's by one query, and follows the window while read", () => {
  const w = window_(true);
  const viewport = createViewport(w.q);
  assert.equal(viewport.store.get(), "desk");
  const release = viewport.watch();
  w.resize(false);
  assert.equal(viewport.store.get(), "phone");
  assert.equal(w.q.listeners.size, 1);
  const second = viewport.watch();
  release();
  assert.equal(w.q.listeners.size, 1);
  second();
  assert.equal(w.q.listeners.size, 0);
});

test("preferences keep the stock keys as they were, and an interface's under its own", () => {
  const { map, safe } = mapStorage();
  map.set("sessionGrouping", "list");
  const stock = createPrefs(safe);
  const other = createPrefs(safe, "board");
  assert.equal(stock.get("sessionGrouping", "folders"), "list");
  assert.equal(other.get("sessionGrouping", "folders"), "folders");
  let heard = 0;
  stock.subscribe(() => heard++);
  stock.set("folderSort", "manual");
  other.set("folderSort", "name");
  assert.equal(map.get("folderSort"), "manual");
  assert.equal(map.get("ui.board:folderSort"), "name");
  // Said again, it is no change.
  stock.set("folderSort", "manual");
  stock.remove("folderSort");
  assert.equal(stock.get("folderSort", "x"), "x");
  assert.equal(heard, 2);
});

test("one package's preferences are not another's, whatever dots their names and keys have", () => {
  const { map, safe } = mapStorage();
  // npm names may have dots: package `foo` with key `bar.x` and package `foo.bar` with key `x` were one key.
  createPrefs(safe, "foo").set("bar.x", "of foo");
  createPrefs(safe, "foo.bar").set("x", "of foo.bar");
  assert.equal(createPrefs(safe, "foo").get("bar.x", ""), "of foo");
  assert.equal(createPrefs(safe, "foo.bar").get("x", ""), "of foo.bar");
  assert.equal(map.size, 2);
});

test("preferences of a browser that will not store them are the fallbacks", () => {
  const prefs = createPrefs(guarded(() => { throw new Error("blocked"); }));
  prefs.set("a", "1");
  assert.equal(prefs.get("a", "fallback"), "fallback");
});

test("who is using the portal is the person marked primary, and Owner while nobody is", async () => {
  const people = [{ name: "Ada", role: "primary" }, { name: "Bo", role: "guest" }];
  let failing = false;
  const me = createMe({ people: async () => (failing ? Promise.reject(new Error("down")) : { people }) } as never);
  assert.deepEqual(me.store.get(), { name: "Owner", role: "owner", status: "loading" });
  await me.load();
  assert.deepEqual(me.store.get(), { name: "Ada", role: "owner", status: "ready" });
  people.length = 0;
  await me.load();
  assert.equal(me.store.get().name, "Owner");
  failing = true;
  await me.load();
  assert.equal(me.store.get().status, "offline");
});

test("settings hold the few public keys and nothing else of what the portal answers", async () => {
  const settings = createSettings({
    settings: async () => ({ settings: { provider: "p", model: "m", thinkingLevel: "high", apiKey: "secret" }, executor: "container", piSettingsPath: "/home/x/.pi", stored: { apiKey: "secret" } }),
  } as never);
  await settings.load();
  assert.deepEqual(settings.store.get().values, { provider: "p", model: "m", thinkingLevel: "high", executor: "container" });
  assert.deepEqual(Object.keys(settings.store.get().values).sort(), [...PUBLIC_SETTING_KEYS].sort());
  assert.ok(!JSON.stringify(settings.store.get()).includes("secret"));
});

test("the models there are, and what a chat uses, are asked of the portal and changed through it", async () => {
  const calls: unknown[] = [];
  let level = "low";
  const models = createModels({
    allModels: async () => ({ providers: {}, models: [{ provider: "p", id: "m1", name: "One", reasoning: true, input: ["text", "image"], contextWindow: 1000 }, { provider: "p", id: "m2", name: "Two", reasoning: false }] }),
    models: async () => ({ state: { model: { provider: "p", id: "m1" }, thinkingLevel: level }, thinking: { levels: ["low", "high"] }, models: { models: [] } }),
    setConfig: async (id: string, patch: unknown) => {
      calls.push([id, patch]);
      level = "high";
    },
  } as never);
  await models.load();
  assert.deepEqual(models.store.get().models.map((m) => [m.id, m.images, m.reasoning]), [["m1", true, true], ["m2", false, false]]);
  assert.deepEqual(models.current("a"), { model: null, thinking: "", levels: [] });
  const chat = await models.loadChat("a");
  assert.deepEqual(chat, { model: { provider: "p", id: "m1" }, thinking: "low", levels: ["low", "high"] });
  const after = await models.set("a", { thinkingLevel: "high" });
  assert.equal(after.thinking, "high");
  assert.deepEqual(calls, [["a", { thinkingLevel: "high" }]]);
  assert.equal(models.current("a").thinking, "high");
  // A change that does not read the chat back, for the pills that read it themselves.
  const asked: string[] = [];
  const bare = createModels({ setConfig: async (id: string) => void asked.push(id), models: async () => (asked.push("read"), {}) } as never);
  await bare.change("b", { autoCompaction: false });
  assert.deepEqual(asked, ["b"]);
});

test("the status says whether the portal can be reached, whether it is behind, and where chats run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const poll = polls();
  const src = streams();
  const sessions = createSessions({
    api: { sessions: async () => { if (down) throw new Error("x"); return { sessions: [session("a")], executor: "container", extensions: "r" }; } } as never,
    ask: async () => true,
    poll: poll.poll,
  });
  const chats = createChats({ api: { session: async (id: string) => session(id) } as never, ask: async () => true, open: src.open, poll: poll.poll, frame: frames().frame, sessions, fanOut: { serverPush() {}, extensionMessage() {}, fill() {}, onScreen() {} } });
  let down = false;
  let snapshot: { status: { notice?: { count: number }; run?: { state: string } } | null; lost: boolean } = { status: null, lost: false };
  const updateListeners = new Set<() => void>();
  const status = createStatus({ sessions, chats, update: { snapshot: () => snapshot as never, subscribe: (l) => (updateListeners.add(l), () => void updateListeners.delete(l)) } });
  const seen: unknown[] = [];
  const stop = status.subscribe(() => seen.push(status.get()));
  await sessions.refresh();
  assert.deepEqual(status.get(), { connection: "online", update: { behind: 0, running: false, lost: false }, executor: "container" });
  // The chat on screen losing its stream twice is an unstable connection.
  chats.open("a");
  src.of("a").fail();
  src.of("a").fail();
  assert.equal(status.get().connection, "unstable");
  t.mock.timers.reset();
  snapshot = { status: { notice: { count: 3 }, run: { state: "running" } }, lost: false };
  updateListeners.forEach((l) => l());
  assert.deepEqual(status.get().update, { behind: 3, running: true, lost: false });
  down = true;
  await sessions.refresh().catch(() => {});
  assert.equal(status.get().connection, "offline");
  assert.ok(seen.length >= 3);
  stop();
});

/** A composer over what the box keeps in memory, and the portal's answers. */
function composerOf(gate?: Promise<void>) {
  const { safe } = mapStorage();
  const drafts = createDrafts(safe);
  const pending = createPending();
  const sent: unknown[] = [];
  const uploaded: string[] = [];
  let failing = false;
  let listCalls = 0;
  const composer = createComposer({
    api: {
      commands: async () => (listCalls++, { commands: [{ name: "compact", source: "builtin" }] }),
      uploadFile: async (_id: string, _dir: string, file: File) => (uploaded.push(file.name), { path: `files/${file.name}`, size: 1 }),
    } as never,
    drafts,
    pending,
    prepare: async (file) => (await gate, { id: `att-${file.name}`, name: file.name, mimeType: "image/png", data: "data:" }) as Attachment,
    chat: () => ({ send: async (m, o) => (failing ? Promise.reject(new Error("no")) : void sent.push([m, o])) }),
  });
  return { composer, drafts, pending, sent, uploaded, fail: (v: boolean) => (failing = v), listed: () => listCalls };
}

test("what is typed is kept per chat, and a second reader of the composer sees it", () => {
  const { composer, drafts } = composerOf();
  const seen: unknown[] = [];
  composer.store.subscribe(() => seen.push(composer.store.get().a));
  composer.setDraft("a", "half a thought");
  assert.equal(composer.get("a").draft, "half a thought");
  assert.equal(composer.get("b").draft, "");
  assert.equal(drafts.get("a"), "half a thought");
  assert.equal(seen[0], composer.store.get().a);
  assert.equal(composer.canSubmit("a"), true);
  assert.equal(composer.canSubmit("b"), false);
});

test("a picture waits with the message, a file is put in the chat's folder and named in it", async () => {
  const { composer, uploaded } = composerOf();
  composer.setDraft("a", "look at this");
  const problems = await composer.attach("a", [new File(["x"], "pic.png", { type: "image/png" }), new File(["y"], "notes.pdf", { type: "application/pdf" })]);
  assert.deepEqual(problems, []);
  assert.deepEqual(uploaded, ["notes.pdf"]);
  assert.deepEqual(composer.get("a").attachments.map((a) => a.name), ["pic.png"]);
  assert.match(composer.get("a").draft, /look at this\n\(I put `files\/notes.pdf` in the folder.\)/);
  assert.equal(composer.get("a").adding, 0);
  composer.detach("a", "att-pic.png");
  assert.deepEqual(composer.get("a").attachments, []);
});

test("a message waits for the pictures being added", async () => {
  let release!: () => void;
  const { composer } = composerOf(new Promise<void>((r) => (release = r)));
  composer.setDraft("a", "go");
  const adding = composer.attach("a", [new File(["y"], "later.png", { type: "image/png" })]);
  assert.equal(composer.get("a").adding, 1);
  assert.equal(composer.canSubmit("a"), false);
  assert.equal(await composer.submit("a"), false);
  release();
  await adding;
  assert.equal(composer.get("a").adding, 0);
  assert.equal(composer.canSubmit("a"), true);
});

test("sending takes the words and the pictures, and empties the box", async () => {
  const { composer, sent, pending } = composerOf();
  composer.setDraft("a", "  hello  ");
  await composer.attach("a", [new File(["x"], "pic.png", { type: "image/png" })]);
  assert.equal(await composer.submit("a", { steer: true }), true);
  assert.deepEqual(sent, [["hello", { steer: true, images: [{ id: "att-pic.png", name: "pic.png", mimeType: "image/png", data: "data:" }] }]]);
  assert.equal(composer.get("a").draft, "");
  assert.deepEqual(pending.get("a"), []);
  assert.equal(await composer.submit("a"), false);
});

test("a message that did not go is back in front of what was typed since, with its pictures", async () => {
  const { composer, fail } = composerOf();
  composer.setDraft("a", "first try");
  await composer.attach("a", [new File(["x"], "pic.png", { type: "image/png" })]);
  fail(true);
  const sending = composer.submit("a");
  // Typed while it was on its way.
  composer.setDraft("a", "and more");
  await assert.rejects(sending, /no/);
  assert.equal(composer.get("a").draft, "first try\nand more");
  assert.equal(composer.get("a").attachments.length, 1);
  assert.equal(composer.get("a").sending, false);
});

test("the pictures voice mode adds to the same chat show in the composer too", () => {
  const { composer, pending } = composerOf();
  pending.set("a", [{ id: "v", name: "voice.png", mimeType: "image/png", data: "" }]);
  assert.equal(composer.get("a").attachments.length, 1);
  assert.equal(composer.store.get().a.attachments[0].name, "voice.png");
});

test("the commands of a chat are fetched once for a key, and again when the key changes", async () => {
  const { composer, listed } = composerOf();
  await composer.loadCommands("a", "1");
  await composer.loadCommands("a", "1");
  assert.equal(listed(), 1);
  assert.deepEqual(composer.get("a").commands.map((c) => c.name), ["compact"]);
  await composer.loadCommands("a", "2");
  assert.equal(listed(), 2);
  await settle();
});

test("a message put back, a box emptied and a send on its way are each shown to every reader of the composer", async () => {
  const { composer, drafts, pending } = composerOf();
  composer.setDraft("a", "typed since");
  composer.putBack("a", "did not go", [{ id: "p", name: "p.png", mimeType: "image/png", data: "" }]);
  assert.equal(composer.store.get().a.draft, "did not go\ntyped since");
  assert.equal(composer.store.get().a.attachments.length, 1);
  // Held for as long as the work runs, and not after it, whether it went or not.
  let release!: () => void;
  const going = composer.whileSending("a", () => new Promise<void>((r) => (release = r)));
  assert.equal(composer.store.get().a.sending, true);
  assert.equal(composer.canSubmit("a"), false);
  release();
  await going;
  assert.equal(composer.store.get().a.sending, false);
  await assert.rejects(composer.whileSending("a", async () => Promise.reject(new Error("no"))), /no/);
  assert.equal(composer.store.get().a.sending, false);
  composer.clear("a");
  assert.equal(composer.store.get().a.draft, "");
  assert.equal(composer.store.get().a.attachments.length, 0);
  assert.equal(drafts.get("a"), "");
  assert.deepEqual(pending.get("a"), []);
});

test("two messages on their way in one chat keep it sending until the last has gone", async () => {
  const { composer } = composerOf();
  composer.setDraft("a", "from the box");
  let releaseBox!: () => void;
  let releaseCommand!: () => void;
  // A message from the box, and a status line's command sent while it is still on its way.
  const box = composer.whileSending("a", () => new Promise<void>((r) => (releaseBox = r)));
  const command = composer.whileSending("a", () => new Promise<void>((r) => (releaseCommand = r)));
  releaseCommand();
  await command;
  assert.equal(composer.store.get().a.sending, true);
  assert.equal(composer.canSubmit("a"), false);
  releaseBox();
  await box;
  assert.equal(composer.store.get().a.sending, false);
  assert.equal(composer.canSubmit("a"), true);
});

test("commands are asked of a pi that is up without starting one, and a list that came that way is the list for its key", async () => {
  const asked: unknown[] = [];
  const running = { value: false };
  const { safe } = mapStorage();
  const composer = createComposer({
    api: {
      commands: async (_id: string, opts?: { ifRunning?: boolean }) => (asked.push(opts ?? "start"), opts?.ifRunning && !running.value ? { commands: [], notRunning: true } : { commands: [{ name: "deploy", source: "extension" }] }),
    } as never,
    drafts: createDrafts(safe),
    pending: createPending(),
    chat: () => ({ send: async () => {} }),
  });
  assert.equal(composer.commandsAreFor("a", "1"), false);
  assert.equal(await composer.loadCommandsIfRunning("a", "1"), undefined);
  assert.equal(composer.commandsAreFor("a", "1"), false);
  assert.deepEqual(composer.get("a").commands, []);
  running.value = true;
  assert.deepEqual((await composer.loadCommandsIfRunning("a", "1"))?.map((c) => c.name), ["deploy"]);
  assert.equal(composer.commandsAreFor("a", "1"), true);
  assert.deepEqual(composer.get("a").commands.map((c) => c.name), ["deploy"]);
  // The same key again is the list held, not a new question; and none of it started a pi.
  await composer.loadCommands("a", "1");
  assert.deepEqual(asked, [{ ifRunning: true }, { ifRunning: true }]);
  assert.equal(composer.commandsAreFor("a", "2"), false);
});
