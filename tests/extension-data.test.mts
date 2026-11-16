import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../core/web/src/api.ts";
import { createChats, type ChatsApi } from "../core/web/src/kernel/chats.ts";
import { createSessions, type SessionsApi } from "../core/web/src/kernel/sessions.ts";
import type { Kernel } from "../core/web/src/kernel/context.tsx";
import { frames, polls, session, settle, streams } from "./kernel-fakes.mts";

// The portal's own confirm dialog, with nothing mounted to draw it: it asks through the browser's, which the test answers.
const confirmed: string[] = [];
let answer = false;
(globalThis as { window?: unknown }).window = { confirm: (text: string) => (confirmed.push(text), answer) };
(globalThis as { history?: unknown }).history = { state: null };
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
});
const { confirmDialog } = await import("../core/web/src/components/ConfirmDialog.tsx");
const { dataFor, sessionsView } = await import("../core/web/src/extensions/data.ts");

/** What a chat's row holds on the server, beyond what the contract names. */
const wide = (id: string): Session =>
  ({ ...session(id), pi_session_file: "/home/x/.pi/sessions/a.jsonl", channel_slug: "telegram", channel_key: "telegram:4711", last_person_key: "telegram:4711", tools_on: "[]", reloads: 2 }) as unknown as Session;

function kernel() {
  const deleted: string[] = [];
  const api = {
    sessions: async () => ({ sessions: [wide("a"), wide("b")], executor: "host", extensions: "r1" }),
    session: async (id: string) => wide(id),
    createSession: async () => wide("new"),
    deleteSession: async (id: string) => void deleted.push(id),
  } as unknown as SessionsApi;
  const sessions = createSessions({ api, ask: confirmDialog, poll: polls().poll });
  const sources = streams();
  const chatsApi = { olderEvents: async () => ({ events: [], more: false }), session: async (id: string) => session(id), deleteMessage: async (id: string, seq: number) => void deleted.push(`${id}:${seq}`) } as unknown as ChatsApi;
  const chats = createChats({
    api: chatsApi,
    ask: confirmDialog,
    open: sources.open,
    poll: polls().poll,
    frame: frames().frame,
    sessions,
    fanOut: { serverPush() {}, extensionMessage() {}, fill() {}, onScreen() {} },
  });
  return { kernel: { sessions, chats } as unknown as Kernel, sessions, chats, deleted };
}

test("with Ask before deleting off, a delete the person clicks is not asked, and one a part starts is", async () => {
  storage.set("confirmDeletes", "off");
  const { kernel: k, sessions, chats, deleted } = kernel();
  sessions.start();
  await settle();
  const part = dataFor("x", k);

  // The stock interface: the person's own click, and their switch.
  await sessions.actions.remove("a");
  await chats.controller("a").deleteMessage(3);
  assert.deepEqual(deleted, ["a", "a:3"]);
  assert.deepEqual(confirmed, []);

  // A part: always asked, and nothing is deleted on a no.
  answer = false;
  assert.equal(await part.sessions.actions.remove("b"), false);
  assert.equal(await part.sessions.actions.removeMany(["b"]), null);
  assert.equal(await part.controller("a").deleteMessage(3), false);
  assert.equal(await part.controller("a").removeTurn(3), false);
  assert.equal(confirmed.length, 4);
  assert.deepEqual(deleted, ["a", "a:3"]);
  // And on a yes, it is done.
  answer = true;
  assert.equal(await part.sessions.actions.remove("b"), true);
  assert.deepEqual(deleted, ["a", "a:3", "b"]);
  // A part that says it was not one does not make it so.
  answer = false;
  assert.equal(await part.controller("a").deleteMessage(3, { unasked: false } as never), false);
  storage.delete("confirmDeletes");
});

test("a part is handed one frozen set of a chat's actions each time, which the page's own is not", () => {
  const { kernel: k, chats } = kernel();
  const part = dataFor("x", k);
  const mine = part.controller("a");
  assert.equal(part.controller("a"), mine);
  assert.ok(Object.isFrozen(mine));
  assert.notEqual(mine, chats.controller("a"));
  assert.equal(mine.queued, chats.controller("a").queued);
});

test("a part is handed a chat as the contract names it, and none of the rest of what the portal says of it", async () => {
  const { kernel: k, sessions } = kernel();
  sessions.start();
  await settle();
  const part = dataFor("x", k);
  const found = part.sessions.find("a")!;
  assert.equal(found.id, "a");
  assert.equal(found.title, "Chat a");
  for (const key of ["pi_session_file", "channel_slug", "channel_key", "last_person_key", "tools_on", "reloads", "executor"]) assert.ok(!(key in found), key);
  assert.ok(Object.isFrozen(found));
  // The same object while the page's row is, and none for a chat it does not have.
  assert.equal(part.sessions.find("a"), found);
  assert.equal(part.sessions.find("nope"), null);
  // A chat made through it comes back the same way.
  const made = await part.sessions.actions.create();
  assert.ok(!("channel_key" in made));
  // The list: frozen, and the same array while the page's list is the same one.
  const state = sessions.store.get();
  const view = sessionsView(state);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.list));
  assert.throws(() => (view.list as unknown as unknown[]).sort(), TypeError);
  assert.ok(view.list.every((row) => !("pi_session_file" in row)));
  assert.equal(sessionsView({ ...state, error: "x" }).list, view.list);
  assert.equal(view.list[0], found);
});
