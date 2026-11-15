import { test } from "node:test";
import assert from "node:assert/strict";
import { createChats, MOST_LIVE, type ChatsApi, type FanOut } from "../core/web/src/kernel/chats.ts";
import type { Question } from "../core/web/src/kernel/confirms.ts";
import type { ChatMode, PortalEvent } from "../core/web/src/api.ts";
import { apiError, event, frames, polls, session, settle, streams } from "./kernel-fakes.mts";

const status = (seq: number, s: string) => event(seq, "portal_status", { status: s });
const said = (seq: number, text: string) => event(seq, "message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });

function make(opts: { modes?: ChatMode[]; answers?: boolean[]; most?: number; older?: PortalEvent[]; missing?: string[] } = {}) {
  const calls: string[] = [];
  const body: Record<string, unknown> = {};
  const asked: Question[] = [];
  const answers = [...(opts.answers ?? [])];
  const sources = streams();
  const frame = frames();
  const poll = polls();
  const fan = { push: [] as unknown[], message: [] as unknown[], fills: [] as string[], screen: [] as (string | undefined)[] };
  const fanOut: FanOut = {
    serverPush: (chat, extension, data) => fan.push.push([chat, extension, data]),
    extensionMessage: (chat, extension, data) => fan.message.push([chat, extension, data]),
    fill: (chat, ev) => fan.fills.push(`${chat}:${ev.seq}`),
    onScreen: (chat) => fan.screen.push(chat),
  };
  const patched: string[] = [];
  let refreshed = 0;
  const api = {
    olderEvents: async (id: string, before: number, limit?: number) => {
      calls.push(`older ${id} ${before} ${limit}`);
      if (opts.missing?.includes(id)) return apiError(404);
      return { events: opts.older ?? [], more: false };
    },
    session: async (id: string) => {
      calls.push(`session ${id}`);
      return opts.missing?.includes(id) ? apiError(404) : session(id);
    },
    prompt: async (id: string, message: string, options: unknown) => (calls.push(`prompt ${id}`), (body.prompt = [message, options]), { ok: true }),
    abort: async (id: string) => (calls.push(`abort ${id}`), { ok: true }),
    editMessage: async (id: string, seq: number, message: string) => (calls.push(`edit ${id} ${seq}`), (body.edit = message), { ok: true }),
    deleteMessage: async (id: string, seq: number) => (calls.push(`delete ${id} ${seq}`), { ok: true }),
    takeBackQueued: async (id: string, seq: number) => (calls.push(`takeBack ${id} ${seq}`), { ok: true }),
    sendQueuedNow: async (id: string, seq: number) => (calls.push(`sendNow ${id} ${seq}`), { ok: true }),
    switchVersion: async (id: string, seq: number, to: number) => (calls.push(`version ${id} ${seq} ${to}`), { ok: true }),
    trustFlagged: async (id: string, result: string) => (calls.push(`trust ${id} ${result}`), { ok: true }),
    chatModes: async (id: string) => (calls.push(`modes ${id}`), { modes: opts.modes ?? [] }),
    setMode: async (id: string, mode: string, confirmed?: boolean) => (calls.push(`setMode ${id} ${mode} ${confirmed ? "confirmed" : "plain"}`), { mode }),
    renameSession: async (id: string) => (calls.push(`rename ${id}`), session(id)),
  } as unknown as ChatsApi;
  const chats = createChats({
    api,
    ask: async (q) => (asked.push(q), answers.shift() ?? true),
    open: sources.open,
    poll: poll.poll,
    frame: frame.frame,
    sessions: { patchStatus: (id, s) => patched.push(`${id}:${s}`), refresh: async () => (refreshed++, []) },
    fanOut,
    most: opts.most,
  });
  return { chats, calls, body, asked, sources, frame, poll, fan, patched, refreshed: () => refreshed };
}

test("a chat is replayed, then its tail is applied a frame at a time", async () => {
  const { chats, sources, frame } = make();
  chats.acquire("a");
  const s = sources.of("a");
  assert.equal(s.since, 0);
  assert.equal(chats.peek("a").loaded, false);
  s.start({ events: [event(1, "agent_start"), said(2, "Hi")] });
  assert.equal(chats.peek("a").loaded, true);
  assert.deepEqual(chats.peek("a").events.map((e) => e.seq), [1, 2]);
  // What comes after is gathered until the frame.
  s.send(event(3, "agent_start"));
  s.send(event(4, "agent_end"));
  assert.equal(chats.peek("a").events.length, 2);
  frame.tick();
  assert.deepEqual(chats.peek("a").events.map((e) => e.seq), [1, 2, 3, 4]);
});

test("every reader of a chat shares one stream, which closes with the last", () => {
  const { chats, sources } = make();
  const one = chats.acquire("a");
  const two = chats.acquire("a");
  assert.equal(sources.all.length, 1);
  // A second consumer sees the same snapshot.
  sources.of("a").start({ events: [said(1, "Hi")] });
  assert.equal(chats.stateOf("a")!.get(), chats.peek("a"));
  one();
  assert.equal(sources.of("a").closed, false);
  two();
  assert.equal(sources.of("a").closed, true);
  // What it held went with it.
  assert.equal(chats.peek("a").loaded, false);
});

test("a chat's status is what its events say, and the list is told at once and asked again", async () => {
  const { chats, sources, frame, patched, refreshed } = make();
  chats.open("a");
  const s = sources.of("a");
  s.start({ events: [status(1, "running")] });
  assert.equal(chats.peek("a").status, "running");
  assert.deepEqual(patched, ["a:running"]);
  s.send(status(2, "idle"));
  frame.tick();
  assert.equal(chats.peek("a").status, "idle");
  assert.deepEqual(patched, ["a:running", "a:idle"]);
  assert.equal(refreshed(), 2);
});

test("only the chat on screen passes on what the extensions and the box are told", () => {
  const { chats, sources, fan } = make();
  chats.open("a");
  chats.acquire("b");
  for (const id of ["a", "b"]) {
    const s = sources.of(id);
    s.start();
    s.named_("extension", { extension: "x/y", data: { n: 1 } });
    s.send(event(-5, "portal_extension_ui", { extension: "x/y", data: "hello" }));
    s.send(event(-6, "extension_ui_request", { id: "q", method: "setEditorText", text: "hi" }));
  }
  assert.deepEqual(fan.push, [["a", "x/y", { n: 1 }]]);
  assert.deepEqual(fan.message, [["a", "x/y", "hello"]]);
  assert.deepEqual(fan.fills, ["a:-6"]);
  assert.deepEqual(fan.screen, ["a"]);
});

test("leaving the chat tells that none is on screen, and a chat read beside it then passes nothing on", () => {
  const { chats, sources, fan } = make();
  const leave = chats.open("a");
  sources.of("a").start();
  chats.acquire("a");
  leave();
  assert.equal(fan.screen.at(-1), undefined);
  sources.of("a").named_("extension", { extension: "x/y", data: 1 });
  assert.deepEqual(fan.push, []);
});

test("a chat read beside the one on screen, and then opened, is read again so that it hears what the page is told as a stream opens", () => {
  const { chats, sources, fan } = make();
  chats.acquire("a");
  sources.of("a").start({ events: [said(1, "Hi")] });
  chats.open("a");
  assert.equal(sources.all.length, 2);
  assert.equal(sources.all[0].closed, true);
  // From where it had read to, not from the start.
  assert.equal(sources.all[1].since, 1);
  sources.all[1].named_("extension", { extension: "x/y", data: 7 });
  assert.deepEqual(fan.push, [["a", "x/y", 7]]);
});

test("questions an extension is blocking on are queued in order, and go when answered or cancelled", () => {
  const { chats, sources } = make();
  chats.open("a");
  const s = sources.of("a");
  s.start({ events: [event(-1, "extension_ui_request", { id: "q1", method: "confirm", title: "Sure?" })] });
  s.send(event(-2, "extension_ui_request", { id: "q2", method: "select" }));
  // One way: no dialog.
  s.send(event(-3, "extension_ui_request", { id: "n", method: "notify" }));
  // The same again is not twice.
  s.send(event(-1, "extension_ui_request", { id: "q1", method: "confirm" }));
  assert.deepEqual(chats.peek("a").dialogs.map((d) => d.id), ["q1", "q2"]);
  chats.dismissDialog("a", "q1");
  s.send(event(-4, "extension_ui_cancel", { id: "q2" }));
  // Live events do not move the cursor a reconnect reads from.
  assert.deepEqual(chats.peek("a").dialogs, []);
});

test("messages taken out of the conversation go from what is held, and from a replay still being gathered", () => {
  const { chats, sources } = make();
  chats.acquire("a");
  const s = sources.of("a");
  s.open();
  s.send(event(1, "agent_start"));
  s.send(event(2, "agent_end"));
  s.send(event(3, "portal_removed", { from: 2, to: 3 }));
  s.named_("caught-up");
  assert.deepEqual(chats.peek("a").events.map((e) => e.seq), [1]);
  s.send(event(4, "agent_start"));
  s.send(event(5, "portal_removed", { from: 4, to: null }));
  assert.deepEqual(chats.peek("a").events.map((e) => e.seq), [1]);
});

test("the versions of messages come with the stream and change live", () => {
  const { chats, sources } = make();
  chats.acquire("a");
  const s = sources.of("a");
  s.start({ versions: { 5: [2, 5] } });
  assert.deepEqual(chats.peek("a").versions, { 5: [2, 5] });
  s.send(event(-9, "portal_versions", { versions: { 5: [2, 5, 9] } }));
  assert.deepEqual(chats.peek("a").versions, { 5: [2, 5, 9] });
});

test("a chat loaded again from the start keeps what is shown until all of it has come", () => {
  const { chats, sources, frame } = make();
  chats.acquire("a");
  const first = sources.of("a");
  first.start({ events: [said(1, "old one"), said(2, "old two")] });
  first.send(event(-3, "portal_reload", { reloads: 1 }));
  frame.tick();
  assert.equal(first.closed, true);
  const again = sources.of("a");
  assert.equal(again.since, 0);
  again.open();
  again.named_("reloads", { reloads: 1 });
  again.send(said(1, "new one"));
  // Not drawn half-built: what was shown is still all there is.
  assert.deepEqual(chats.peek("a").events.map((e) => e.seq), [1, 2]);
  again.named_("caught-up");
  assert.equal(chats.peek("a").events.length, 1);
});

test("a reload count that is not the last one seen, as a stream opens, is a reload missed: it reads from the start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { chats, sources } = make();
  chats.acquire("a");
  const first = sources.of("a");
  first.start({ reloads: 1, events: [said(1, "Hi")] });
  first.fail();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(2000);
  // The reconnect reads on from the cursor...
  const second = sources.of("a");
  assert.notEqual(second, first);
  assert.equal(second.since, 1);
  // ...and finds that the count moved: events came back under seqs it had read past.
  second.open();
  second.named_("reloads", { reloads: 2 });
  const third = sources.of("a");
  assert.equal(second.closed, true);
  assert.equal(third.since, 0);
});

test("a stream that drops keeps what arrived, says so, and reads on from where it was", async () => {
  const { chats, sources, calls } = make();
  chats.acquire("a");
  const s = sources.of("a");
  s.start({ events: [said(1, "Hi")] });
  s.fail();
  assert.equal(chats.peek("a").failures, 1);
  assert.equal(chats.peek("a").events.length, 1);
  await settle();
  assert.ok(calls.includes("session a"));
});

test("a chat the portal has none of is missing, and its stream is not tried again", async () => {
  const { chats, sources } = make({ missing: ["a"] });
  chats.open("a");
  sources.of("a").fail();
  await settle();
  assert.equal(chats.peek("a").missing, true);
  assert.equal(sources.all.length, 1);
});

test("the replay says whether the conversation goes on above it, and loading earlier puts it in front", async () => {
  const older = [said(1, "first"), said(2, "second")];
  const { chats, sources, calls } = make({ older });
  chats.acquire("a");
  sources.of("a").start({ events: [said(5, "latest")] });
  await settle();
  assert.ok(calls.includes("older a 5 1"));
  assert.equal(chats.peek("a").moreBefore, true);
  await chats.controller("a").loadEarlier();
  assert.deepEqual(chats.peek("a").events.map((e) => e.seq), [1, 2, 5]);
  assert.equal(chats.peek("a").moreBefore, false);
  assert.equal(chats.peek("a").loadingBefore, false);
});

test("an earlier page that comes after the chat was loaded again is not put in front of the new one", async () => {
  const { chats, sources, frame } = make({ older: [said(1, "stale")] });
  chats.acquire("a");
  const first = sources.of("a");
  first.start({ events: [said(5, "latest")] });
  await settle();
  const wait = chats.controller("a").loadEarlier();
  // The chat is loaded again before the page comes.
  first.send(event(-1, "portal_reload", { reloads: 1 }));
  frame.tick();
  const again = sources.of("a");
  again.open();
  again.named_("reloads", { reloads: 1 });
  again.send(said(7, "fresh"));
  again.named_("caught-up");
  await wait;
  assert.deepEqual(chats.peek("a").events.map((e) => e.seq), [7]);
});

test(`at most ${MOST_LIVE} streams are live: a fifth chat is a snapshot, asked for again every few seconds`, async () => {
  const { chats, sources, poll, calls } = make({ older: [status(9, "running"), said(10, "so far")] });
  for (const id of ["a", "b", "c", "d"]) chats.acquire(id);
  chats.acquire("e");
  assert.deepEqual(chats.live(), ["a", "b", "c", "d"]);
  assert.deepEqual(chats.polled(), ["e"]);
  assert.equal(sources.live().length, 4);
  await settle();
  assert.equal(chats.peek("e").live, false);
  assert.equal(chats.peek("e").loaded, true);
  assert.equal(chats.peek("e").status, "running");
  assert.deepEqual(chats.peek("e").events.map((e) => e.seq), [9, 10]);
  const asked = calls.filter((c) => c.startsWith("older e")).length;
  poll.tick();
  await settle();
  assert.equal(calls.filter((c) => c.startsWith("older e")).length, asked + 1);
  // Never a fifth stream.
  assert.equal(sources.live().length, 4);
});

test("a place that frees goes to the first chat that waited, which is then streamed", async () => {
  const { chats, sources, poll } = make();
  const releases = ["a", "b", "c", "d"].map((id) => chats.acquire(id));
  chats.acquire("e");
  await settle();
  releases[1]();
  assert.deepEqual(chats.live(), ["a", "c", "d", "e"]);
  assert.deepEqual(chats.polled(), []);
  assert.equal(poll.running().length, 0);
  // Read from the start, where it had a snapshot before.
  assert.equal(sources.of("e").since, 0);
});

test("the chat on screen is streamed first: it takes the place of the last chat that was read", async () => {
  const { chats } = make();
  for (const id of ["a", "b", "c", "d"]) chats.acquire(id);
  chats.open("e");
  assert.deepEqual(chats.live(), ["a", "b", "c", "e"]);
  assert.deepEqual(chats.polled(), ["d"]);
});

test("a snapshot keeps what was read back above it", async () => {
  const { chats, poll } = make({ older: [said(20, "newest")], most: 1 });
  chats.acquire("a");
  chats.acquire("b");
  await settle();
  assert.deepEqual(chats.polled(), ["b"]);
  poll.tick();
  await settle();
  assert.deepEqual(chats.peek("b").events.map((e) => e.seq), [20]);
});

test("a snapshot of a chat the portal has none of says so", async () => {
  const { chats } = make({ most: 1, missing: ["b"] });
  chats.acquire("a");
  chats.acquire("b");
  await settle();
  assert.equal(chats.peek("b").missing, true);
});

test("sending, stopping and editing go to the portal for the chat they are bound to, and the list is asked again", async () => {
  const { chats, calls, body, refreshed } = make();
  const c = chats.controller("a");
  await c.send("hello", { steer: true });
  await c.abort();
  await c.edit(4, "better");
  await c.queued.takeBack(6);
  await c.queued.sendNow(7);
  await c.switchVersion(4, 2);
  await c.rename("New name");
  assert.deepEqual(calls, ["prompt a", "abort a", "edit a 4", "takeBack a 6", "sendNow a 7", "version a 4 2", "rename a"]);
  assert.deepEqual(body.prompt, ["hello", { steer: true }]);
  assert.equal(body.edit, "better");
  await settle();
  assert.ok(refreshed() >= 4);
  // The same actions each time, for what is drawn with them.
  assert.equal(chats.controller("a"), c);
});

test("deleting a message asks first, and calls the portal only after a yes", async () => {
  const { chats, calls, asked } = make({ answers: [false, true] });
  const c = chats.controller("a");
  const order: string[] = [];
  assert.equal(await c.deleteMessage(3, { accepted: () => order.push("accepted") }), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(order, []);
  assert.equal(await c.deleteMessage(3, { accepted: () => order.push(`accepted after ${calls.length} calls`) }), true);
  assert.deepEqual(calls, ["delete a 3"]);
  // Before the portal was asked, once the person had said yes.
  assert.deepEqual(order, ["accepted after 0 calls"]);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].danger, true);
  assert.equal(asked[0].deletes, true);
});

test("removing the turn a flagged result came in asks the same, and deletes the message that began it", async () => {
  const { chats, calls, asked } = make({ answers: [false, true] });
  const c = chats.controller("a");
  assert.equal(await c.removeTurn(2), false);
  assert.equal(await c.removeTurn(2), true);
  assert.deepEqual(calls, ["delete a 2"]);
  assert.equal(asked.length, 2);
});

test("trusting a flagged result asks first, and says so in the chat's state once it is", async () => {
  const { chats, calls, asked } = make({ answers: [false, true] });
  chats.acquire("a");
  const c = chats.controller("a");
  assert.equal(await c.trustFlagged("abc"), false);
  assert.deepEqual(calls, []);
  assert.equal(await c.trustFlagged("abc"), true);
  assert.deepEqual(calls, ["trust a abc"]);
  assert.deepEqual(chats.peek("a").trusted, ["abc"]);
  assert.equal(asked[0].danger, true);
  assert.match(asked[0].message ?? "", /no longer held back/);
});

const asks: ChatMode = { id: "ext/risky", label: "Risky", description: "d", confirm: "It may delete things." };
const plain: ChatMode = { id: "code", label: "Code", description: "d" };

test("a mode that asks is asked about, and the portal is told it was said yes to", async () => {
  const { chats, calls, asked } = make({ modes: [asks, plain], answers: [false, true] });
  const c = chats.controller("a");
  assert.equal(await c.setMode("ext/risky"), false);
  assert.deepEqual(calls.filter((x) => x.startsWith("setMode")), []);
  assert.equal(await c.setMode("ext/risky"), true);
  assert.deepEqual(calls.filter((x) => x.startsWith("setMode")), ["setMode a ext/risky confirmed"]);
  assert.equal(asked[0].title, "Use Risky?");
  assert.equal(asked[0].message, "It may delete things.");
});

test("a mode that does not ask is not asked about, and is not called confirmed", async () => {
  const { chats, calls, asked } = make({ modes: [asks, plain] });
  const shown: string[] = [];
  assert.equal(await chats.controller("a").setMode("code", { accepted: () => shown.push("shown") }), true);
  assert.equal(asked.length, 0);
  assert.deepEqual(calls.filter((x) => x.startsWith("setMode")), ["setMode a code plain"]);
  assert.deepEqual(shown, ["shown"]);
});

test("a mode the portal cannot list is not asked about: the portal refuses one that asks without a yes", async () => {
  const { chats, calls, asked } = make({ modes: [] });
  await chats.controller("a").setMode("ext/risky");
  assert.equal(asked.length, 0);
  assert.deepEqual(calls.filter((x) => x.startsWith("setMode")), ["setMode a ext/risky plain"]);
});
