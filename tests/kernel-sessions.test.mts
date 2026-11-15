import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessions, LIST_MS, type SessionsApi } from "../core/web/src/kernel/sessions.ts";
import type { Question } from "../core/web/src/kernel/confirms.ts";
import type { Session } from "../core/web/src/api.ts";
import { apiError, polls, session, settle } from "./kernel-fakes.mts";

/** The portal's chat list as a test holds it, and the calls made to it. */
function portal(initial: Session[]) {
  const state = { chats: initial, failing: false, calls: [] as string[], single: new Map<string, Session>() };
  const api: SessionsApi = {
    sessions: async () => {
      state.calls.push("sessions");
      if (state.failing) throw new Error("down");
      return { sessions: structuredClone(state.chats), executor: "host", extensions: "r1" };
    },
    session: async (id) => {
      state.calls.push(`session ${id}`);
      const s = state.single.get(id);
      return s ? structuredClone(s) : apiError(404);
    },
    createSession: async (workspace) => {
      state.calls.push(`create ${workspace ?? ""}`);
      const s = session("new");
      state.chats = [...state.chats, s];
      return s;
    },
    renameSession: async (id, title) => {
      state.calls.push(`rename ${id}`);
      state.chats = state.chats.map((c) => (c.id === id ? { ...c, title } : c));
      return session(id, { title });
    },
    pinSession: async (id, pinned) => {
      state.calls.push(`pin ${id}`);
      state.chats = state.chats.map((c) => (c.id === id ? { ...c, pinned } : c));
      return session(id, { pinned });
    },
    deleteSession: async (id) => {
      state.calls.push(`delete ${id}`);
      if (id === "stuck") throw new Error("the portal kept it");
      state.chats = state.chats.filter((c) => c.id !== id && c.parent !== id);
      return { ok: true };
    },
  } as unknown as SessionsApi;
  return { state, api };
}

function make(initial: Session[], answers: boolean[] = [true]) {
  const p = portal(initial);
  const asked: Question[] = [];
  const poll = polls();
  const seen: string[] = [];
  const sessions = createSessions({ api: p.api, ask: async (q) => (asked.push(q), answers.shift() ?? true), installed: (r) => seen.push(r), poll: poll.poll });
  return { ...p, sessions, asked, poll, seen };
}

test("the list is asked for once, and every few seconds after, by the kernel", async () => {
  const { sessions, state, poll, seen } = make([session("a")]);
  assert.equal(sessions.store.get().status, "loading");
  const stop = sessions.start();
  await settle();
  assert.equal(sessions.store.get().status, "ready");
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["a"]);
  assert.equal(poll.running()[0].ms, LIST_MS);
  state.chats = [session("a"), session("b")];
  poll.tick();
  await settle();
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["a", "b"]);
  // What is installed was told each time, for the page to follow it.
  assert.deepEqual(seen, ["r1", "r1"]);
  stop();
  assert.equal(poll.running().length, 0);
});

test("a poll that finds nothing new leaves the list as it was, for the parts drawn from it", async () => {
  const { sessions, poll } = make([session("a"), session("b")]);
  sessions.start();
  await settle();
  const before = sessions.store.get().list;
  const row = before[0];
  poll.tick();
  await settle();
  assert.equal(sessions.store.get().list, before);
  assert.equal(sessions.store.get().list[0], row);
});

test("a second reader of the store sees the same snapshot", async () => {
  const { sessions } = make([session("a")]);
  const first: unknown[] = [];
  const second: unknown[] = [];
  sessions.store.subscribe(() => first.push(sessions.store.get()));
  sessions.store.subscribe(() => second.push(sessions.store.get()));
  await sessions.refresh();
  assert.equal(first.length, 1);
  assert.equal(first[0], second[0]);
});

test("a first ask that fails is said once, and the poll that follows is the retry", async () => {
  const { sessions, state, poll } = make([session("a")]);
  state.failing = true;
  sessions.start();
  await settle();
  assert.equal(sessions.store.get().status, "offline");
  assert.equal(sessions.store.get().error, "down");
  // Dismissed, it stays so; and a list that comes ends the outage.
  sessions.actions.dismissError();
  assert.equal(sessions.store.get().error, null);
  state.failing = false;
  poll.tick();
  await settle();
  assert.equal(sessions.store.get().status, "ready");
  assert.equal(sessions.store.get().list.length, 1);
});

test("a poll that fails later does not empty the list or say anything", async () => {
  const { sessions, state, poll } = make([session("a")]);
  sessions.start();
  await settle();
  state.failing = true;
  poll.tick();
  await settle();
  assert.equal(sessions.store.get().status, "offline");
  assert.equal(sessions.store.get().error, null);
  assert.equal(sessions.store.get().list.length, 1);
});

test("deleting a chat asks first, naming the sub-chats that go with it, and does nothing on no", async () => {
  const { sessions, state, asked } = make([session("a"), session("s1", { parent: "a", title: "Helper" })], [false, true]);
  await sessions.refresh();
  assert.equal(await sessions.actions.remove("a"), false);
  assert.equal(asked.length, 1);
  assert.match(asked[0].title, /Chat a/);
  assert.match(asked[0].message ?? "", /"Helper"/);
  assert.equal(asked[0].deletes, true);
  assert.deepEqual(state.calls.filter((c) => c.startsWith("delete")), []);
  assert.equal(await sessions.actions.remove("a"), true);
  assert.deepEqual(state.calls.filter((c) => c.startsWith("delete")), ["delete a"]);
  // The chat and its sub-chat are out of the list.
  assert.deepEqual(sessions.store.get().list, []);
});

test("a chat deleted is gone from the list even when the list cannot be loaded after", async () => {
  const { sessions, state } = make([session("a"), session("b")]);
  await sessions.refresh();
  state.failing = true;
  assert.equal(await sessions.actions.remove("a"), true);
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["b"]);
});

test("a delete the portal refuses is thrown, and the chat stays", async () => {
  const { sessions } = make([session("stuck")]);
  await sessions.refresh();
  await assert.rejects(sessions.actions.remove("stuck"), /kept it/);
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["stuck"]);
});

test("deleting several asks once for all, and says which the portal kept", async () => {
  const { sessions, asked, state } = make([session("a", { status: "running" }), session("stuck"), session("c")], [true]);
  await sessions.refresh();
  const failed = await sessions.actions.removeMany(["a", "stuck", "c"]);
  assert.equal(asked.length, 1);
  assert.match(asked[0].title, /3/);
  assert.match(asked[0].message ?? "", /1 of them is running/);
  assert.deepEqual(failed, [{ id: "stuck", error: "the portal kept it" }]);
  assert.deepEqual(state.calls.filter((c) => c.startsWith("delete")), ["delete a", "delete stuck", "delete c"]);
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["stuck"]);
});

test("deleting several and saying no is null, and nothing is deleted", async () => {
  const { sessions, state } = make([session("a")], [false]);
  await sessions.refresh();
  assert.equal(await sessions.actions.removeMany(["a"]), null);
  assert.deepEqual(state.calls.filter((c) => c.startsWith("delete")), []);
});

test("create, rename and pin go to the portal and show at once", async () => {
  const { sessions } = make([session("a")]);
  await sessions.refresh();
  const made = await sessions.actions.create("/proj");
  assert.equal(made.id, "new");
  assert.ok(sessions.store.get().list.some((s) => s.id === "new"));
  await sessions.actions.rename("a", "Renamed");
  await sessions.actions.pin("a", true);
  const a = sessions.store.get().list.find((s) => s.id === "a")!;
  assert.equal(a.title, "Renamed");
  assert.equal(a.pinned, true);
});

test("a chat outside the list is fetched and kept current while something looks at it", async () => {
  const { sessions, state, poll } = make([session("a")]);
  await sessions.refresh();
  state.single.set("agent-1", session("agent-1", { kind: "agent", title: "An agent" }));
  const release = sessions.watch("agent-1");
  await settle();
  assert.equal(sessions.unlisted.get()["agent-1"].session?.title, "An agent");
  assert.equal(sessions.find("agent-1")?.title, "An agent");
  state.single.set("agent-1", session("agent-1", { kind: "agent", title: "Renamed agent" }));
  poll.tick();
  await settle();
  assert.equal(sessions.find("agent-1")?.title, "Renamed agent");
  release();
  assert.equal(poll.running().length, 0);
});

test("a chat the portal has none of is missing, and is not asked for again", async () => {
  const { sessions, state, poll } = make([]);
  const release = sessions.watch("gone");
  await settle();
  assert.equal(sessions.unlisted.get().gone.missing, true);
  const asks = state.calls.length;
  poll.tick();
  await settle();
  assert.equal(state.calls.length, asks);
  release();
});

test("two readers of one outside chat share one fetch loop, which ends with the last", async () => {
  const { sessions, state } = make([]);
  state.single.set("x", session("x"));
  const one = sessions.watch("x");
  const two = sessions.watch("x");
  await settle();
  assert.equal(state.calls.filter((c) => c === "session x").length, 1);
  one();
  assert.equal(sessions.unlisted.get().x.session?.id, "x");
  two();
});

test("a status heard on a chat's stream shows at once, in the list and for a chat outside it", async () => {
  const { sessions, state } = make([session("a")]);
  state.single.set("o", session("o"));
  await sessions.refresh();
  sessions.watch("o");
  await settle();
  sessions.patchStatus("a", "running");
  sessions.patchStatus("o", "running");
  assert.equal(sessions.store.get().list[0].status, "running");
  assert.equal(sessions.find("o")?.status, "running");
});
