import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlerts, HIDDEN_MS } from "../core/web/src/kernel/alerts.ts";
import { createChats } from "../core/web/src/kernel/chats.ts";
import { createSessions } from "../core/web/src/kernel/sessions.ts";
import type { Session } from "../core/web/src/api.ts";
import { event, frames, polls, session, streams } from "./kernel-fakes.mts";

function make(initial: Session[]) {
  let chatsNow = initial;
  const poll = polls();
  const src = streams();
  const frame = frames();
  const sessions = createSessions({ api: { sessions: async () => ({ sessions: structuredClone(chatsNow), executor: "host", extensions: "r" }) } as never, ask: async () => true, poll: poll.poll });
  const chats = createChats({ api: { olderEvents: async () => ({ events: [], more: false }), session: async (id: string) => session(id) } as never, ask: async () => true, open: src.open, poll: poll.poll, frame: frame.frame, sessions, fanOut: { serverPush() {}, extensionMessage() {}, fill() {}, onScreen() {} } });
  const titles: string[] = [];
  const told: string[][] = [];
  const opened: string[] = [];
  let hidden = false;
  let languageChanged = () => {};
  const alerts = createAlerts({
    sessions,
    chats,
    setTitle: (t) => titles.push(t),
    notify: (title, body, tag, open) => (told.push([title, body, tag]), open()),
    open: (id) => opened.push(id),
    watchingHidden: () => hidden,
    onLanguage: (l) => ((languageChanged = l), () => {}),
  });
  return { sessions, chats, alerts, titles, told, opened, src, frame, set: (s: Session[]) => (chatsNow = s), hide: (h: boolean) => (hidden = h), language: () => languageChanged() };
}

test("the tab says what the chat on screen is doing, and goes back to the name when it stops", async (t) => {
  const { sessions, chats, alerts, titles, set } = make([session("a", { title: "Fix login" })]);
  await sessions.refresh();
  const stop = alerts.start();
  t.after(stop);
  assert.equal(titles.at(-1), "Pithagoras");
  chats.open("a");
  assert.equal(titles.at(-1), "Fix login · Pithagoras");
  set([session("a", { title: "Fix login", status: "running" })]);
  await sessions.refresh();
  assert.equal(titles.at(-1), "● Fix login · working");
  stop();
  assert.equal(titles.at(-1), "Pithagoras");
});

test("a question an extension is blocking on outranks working, in the tab and in a notification, once", async (t) => {
  const { sessions, chats, alerts, titles, told, src } = make([session("a", { title: "Fix login", status: "running" })]);
  await sessions.refresh();
  t.after(alerts.start());
  chats.open("a");
  src.of("a").start({ events: [event(-1, "extension_ui_request", { id: "q1", method: "confirm" })] });
  assert.equal(titles.at(-1), "❓ Fix login · asks you");
  assert.deepEqual(told, [["Fix login", "Waiting for your answer", "ask-a"]]);
  src.of("a").send(event(-2, "extension_ui_request", { id: "q2", method: "select" }));
  assert.equal(told.length, 1);
  chats.dismissDialog("a", "q1");
  chats.dismissDialog("a", "q2");
  assert.equal(titles.at(-1), "● Fix login · working");
});

test("a chat that was running and is done is told, once, and one that was never seen running is not", async (t) => {
  const { sessions, alerts, told, opened, set } = make([session("a", { status: "running" }), session("b", { status: "running" })]);
  await sessions.refresh();
  t.after(alerts.start());
  assert.deepEqual(told, []);
  set([session("a", { status: "idle" }), session("b", { status: "error" }), session("c", { status: "idle" })]);
  await sessions.refresh();
  assert.deepEqual(told.map((t) => [t[0], t[1]]), [["Chat a", "Finished"], ["Chat b", "Stopped with an error"]]);
  assert.deepEqual(opened, ["a", "b"]);
  await sessions.refresh();
  assert.equal(told.length, 2);
});

test("a page that is hidden keeps asking for the list, slowly, while a chat runs and someone wants to hear", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { sessions, alerts, hide, set } = make([session("a", { status: "running" })]);
  await sessions.refresh();
  let asked = 0;
  const refresh = sessions.refresh;
  sessions.refresh = async () => (asked++, refresh());
  t.after(alerts.start());
  t.mock.timers.tick(HIDDEN_MS);
  assert.equal(asked, 0);
  hide(true);
  t.mock.timers.tick(HIDDEN_MS);
  assert.equal(asked, 1);
  // Nothing running: nothing to ask for.
  set([session("a")]);
  await refresh();
  t.mock.timers.tick(HIDDEN_MS * 3);
  assert.equal(asked, 1);
});

test("the tab is said again when the language changes, in case its words did", async (t) => {
  const { sessions, chats, alerts, titles, language } = make([session("a", { title: "Plan" })]);
  await sessions.refresh();
  t.after(alerts.start());
  chats.open("a");
  const before = titles.length;
  assert.equal(titles.at(-1), "Plan · Pithagoras");
  // Nothing changed: nothing said.
  await sessions.refresh();
  assert.equal(titles.length, before);
  language();
  assert.equal(titles.length, before + 1);
});

test("a reconnect of the chat on screen, whose replay holds the question still open, does not tell about it again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sessions, chats, alerts, told, src } = make([session("a", { title: "Fix login" })]);
  await sessions.refresh();
  t.after(alerts.start());
  chats.open("a");
  const ask = event(-1, "extension_ui_request", { id: "q1", method: "confirm" });
  src.of("a").start({ events: [ask] });
  assert.equal(told.length, 1);
  const held = chats.peek("a").dialogs[0];
  src.of("a").fail();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(2000);
  src.of("a").start({ events: [ask] });
  assert.equal(told.length, 1);
  assert.equal(chats.peek("a").dialogs[0], held);
});
