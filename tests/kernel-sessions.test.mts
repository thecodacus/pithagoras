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

test("a chat deleted is out of the list for the page to go on from, before the list is asked for again", async () => {
  const { sessions, api } = make([session("a"), session("b")]);
  await sessions.refresh();
  // The list that follows the delete does not come until the test says so.
  let answer!: () => void;
  const later = new Promise<void>((r) => (answer = r));
  const asked = api.sessions;
  api.sessions = async () => (await later, asked());
  let wentOn: string[] | undefined;
  let refreshedBefore = false;
  const done = sessions.actions.remove("a", (list) => {
    wentOn = list.map((s) => s.id);
    refreshedBefore = sessions.store.get().list !== list;
  });
  await settle();
  // Told while the list is still on its way, with the list that is shown.
  assert.deepEqual(wentOn, ["b"]);
  assert.equal(refreshedBefore, false);
  answer();
  assert.equal(await done, true);
});

test("a list asked for before a delete, that comes after it, does not bring the deleted chat back; a slow portal is still shown", async () => {
  const { sessions, api, state } = make([session("a"), session("b")]);
  await sessions.refresh();
  // A poll is on its way when the chat is deleted; the portal answers it with the list from before the delete, late.
  const asked = api.sessions;
  let answerPoll!: () => void;
  const before = await asked();
  api.sessions = () => new Promise((r) => (answerPoll = () => r(before)));
  const poll = sessions.refresh();
  api.sessions = asked;
  assert.equal(await sessions.actions.remove("a"), true);
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["b"]);
  answerPoll();
  await poll;
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["b"]);
  // A portal slower than the poll: two asks on their way at once, answered in order, are each shown. Only an answer
  // older than one shown is left out, or a list asked for every few seconds would never be shown.
  const answers: (() => void)[] = [];
  api.sessions = () => new Promise((r) => answers.push(() => r(asked())));
  const first = sessions.refresh();
  const second = sessions.refresh();
  state.chats = [session("b"), session("c")];
  answers[0]();
  await first;
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["b", "c"]);
  state.chats = [session("b"), session("c"), session("d")];
  answers[1]();
  await second;
  assert.deepEqual(sessions.store.get().list.map((s) => s.id), ["b", "c", "d"]);
});

test("a deleted chat that was fetched from outside the list is not found after, nor are its sub-chats", async () => {
  const { sessions, state } = make([session("a")]);
  await sessions.refresh();
  state.single.set("agent-1", session("agent-1", { kind: "agent" }));
  state.single.set("sub-1", session("sub-1", { parent: "agent-1" }));
  const release = sessions.watch("agent-1");
  const releaseSub = sessions.watch("sub-1");
  await settle();
  release();
  releaseSub();
  // Kept after its readers went, for the next to find at once.
  assert.equal(sessions.find("agent-1")?.id, "agent-1");
  // Another sub-chat of it is still looked at.
  state.single.set("sub-2", session("sub-2", { parent: "agent-1" }));
  const watched = sessions.watch("sub-2");
  await settle();
  // Deleted from a part that is not looking at it.
  assert.equal(await sessions.actions.remove("agent-1"), true);
  assert.equal(sessions.find("agent-1"), null);
  assert.equal(sessions.find("sub-1"), null);
  // The one still looked at is missing at once, as its next fetch would say.
  assert.equal(sessions.find("sub-2"), null);
  assert.equal(sessions.unlisted.get()["sub-2"].missing, true);
  watched();
});

test("deleting several names every one in the question, those outside the list too, and counts their sub-chats", async () => {
  const { sessions, asked, state } = make([session("a", { title: "Shopping list" }), session("s1", { parent: "agent", title: "Helper" })], [true]);
  state.single.set("agent", session("agent", { title: "Nightly agent" }));
  await sessions.refresh();
  // An agent's chat that something looked at, and one the page knows nothing of.
  const release = sessions.watch("agent");
  await settle();
  await sessions.actions.removeMany(["a", "agent", "unknown-chat"]);
  release();
  assert.match(asked[0].title, /3 chats/);
  const said = asked[0].message ?? "";
  assert.match(said, /"Shopping list"/);
  assert.match(said, /"Nightly agent"/);
  assert.match(said, /"unknown-chat"/);
  assert.match(said, /One sub-chat is deleted with them/);
  assert.deepEqual(state.calls.filter((c) => c.startsWith("delete")), ["delete a", "delete agent", "delete unknown-chat"]);
});

test("deleting a chat outside the list names the sub-chats the list has of it", async () => {
  const { sessions, asked } = make([session("s1", { parent: "agent", title: "Helper" })], [false]);
  await sessions.refresh();
  await sessions.actions.remove("agent");
  assert.match(asked[0].message ?? "", /"Helper"/);
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

test("a delete a part started is marked as one the person did not start, and one from the stock interface is not", async () => {
  const { sessions, asked, state } = make([session("a"), session("b")], [true, true, true, true]);
  sessions.start();
  await settle();
  await sessions.actions.remove("a");
  await sessions.actions.remove("b", undefined, { unasked: true });
  await sessions.actions.removeMany(["a"]);
  await sessions.actions.removeMany(["b"], { unasked: true });
  assert.deepEqual(asked.map((q) => q.unasked), [undefined, true, undefined, true]);
  assert.ok(state.calls.includes("delete b"));
});
