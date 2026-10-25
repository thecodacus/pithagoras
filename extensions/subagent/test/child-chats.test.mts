import { after, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { fakeModel } from "../../../core/server/test/fake-model.mjs";
import { serveSubagent } from "./portal.mts";

/**
 * Subagents as child chats, for real: the extension's server half in the portal's own extension host, the portal's
 * session manager running each chat's pi (a parent and the child chats its subagents work in), and a model that plays
 * the script. The tool's own logic is pi.test.mts's, over stand-ins.
 */

inProcessHome("pithagoras-subagent-chats-");

// The parent hands the riddle on, or asks the same subagent again; the child answers, knowing what it said before.
let childId = "";
// The parent whose child reads outside content as it works (the guard marks the child's chat), and whether the parent
// has been told what a background child said.
let marking = "";
let relayed = false;
const childRequests: any[] = [];
const model = await fakeModel((request: any) => {
  const tools = (request.tools ?? []).map((tool: any) => tool.function?.name);
  const last = request.messages.at(-1);
  const said = JSON.stringify(last?.content ?? "");
  if (tools.includes("subagent")) {
    if (said.includes("finished:")) relayed = true;
    if (last?.role === "tool") return "Done.";
    if (said.includes("Delegate")) return { name: "subagent", args: { task: "Answer the riddle", label: "Riddle" } };
    if (said.includes("Again")) return { name: "subagent", args: { id: childId, task: "What did you answer?" } };
    return "Done.";
  }
  childRequests.push(request);
  if (marking) taintSession(db.childSessions(marking)[0].id);
  if (said.includes("riddle")) return "The answer is 42.";
  if (said.includes("What did you answer")) return JSON.stringify(request.messages).includes("The answer is 42") ? "I said 42." : "I do not know.";
  return "Done.";
});
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify(model.models()));

const dist = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;
const db = await import(dist("db.js"));
const { flaggedResult, sessionTainted, taintSession } = await import(dist("pi/guard.js"));
const { sessions } = await import(dist("session-manager.js"));
db.setSettings({ ...db.getSettings(), provider: "fake", model: "m" });
const portal = await serveSubagent();
after(async () => {
  for (const id of [...sessions.live.keys()]) await sessions.stop(id);
});

const put = (url: string, body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 1500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** What the chat's agent said last, once its run is over. */
async function ask(chatId: string, message: string): Promise<string> {
  const before = db.eventsSince(chatId, 0).length;
  await sessions.prompt(chatId, message);
  await until(() => db.getSession(chatId).status === "idle" && db.eventsSince(chatId, 0).length > before, `the run of ${chatId}`);
  return toolResults(chatId).at(-1) ?? "";
}

/** The texts of the subagent tool's results in a chat, in order. */
const toolResults = (chatId: string): string[] =>
  db
    .eventsSince(chatId, 0)
    .filter((e: any) => e.type === "tool_execution_end")
    .map((e: any) => JSON.parse(e.payload))
    .filter((p: any) => p.toolName === "subagent")
    .map((p: any) => (p.result?.content ?? []).map((c: any) => c.text).join(""));

test("a subagent works in a child chat of its chat, which answers; kept, it is listed under that chat and goes on by its id", { timeout: 60_000 }, async () => {
  assert.equal((await put(`${portal.at}/settings`, { keep: true })).status, 200);
  db.createSession({ id: "parent", title: "Parent", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });

  const first = await ask("parent", "Delegate it");
  const children = db.childSessions("parent");
  assert.equal(children.length, 1, "one child chat");
  childId = children[0].id;
  assert.deepEqual([children[0].title, children[0].listed, children[0].creator], ["Riddle", 1, "pithagoras-subagent"]);
  assert.match(first, new RegExp(`^The answer is 42\\.\\n\\n\\(Its chat is kept as ${childId}: pass that id to continue it\\.\\)$`));
  // Listed with its parent, for the chat list to show under it.
  assert.equal(db.listChatSessions().find((row: any) => row.id === childId)?.parent_id, "parent");
  // Its own transcript has its run; the parent's has no copy of it.
  const said = (id: string) => db.eventsSince(id, 0).filter((e: any) => e.type === "message_end").map((e: any) => JSON.stringify(JSON.parse(e.payload).message?.content));
  assert.ok(said(childId).some((text: string) => text.includes("The answer is 42.")));
  assert.equal(db.eventsSince("parent", 0).filter((e: any) => e.type === "portal_subagent" && JSON.parse(e.payload).op === "event").length, 0);
  // Its subagent's start names the chat, and it ended done.
  const protocol = db.eventsSince("parent", 0).filter((e: any) => e.type === "portal_subagent").map((e: any) => JSON.parse(e.payload));
  assert.deepEqual(protocol.map((p: any) => [p.op, p.id, p.chat ?? p.status]), [["start", childId, childId], ["end", childId, "done"]]);
  // A child chat's pi has no subagent tool.
  assert.ok(childRequests.length > 0 && childRequests.every((r) => !(r.tools ?? []).some((t: any) => t.function?.name === "subagent")));

  const again = await ask("parent", "Again");
  assert.equal(db.childSessions("parent").length, 1, "no second child chat");
  assert.match(again, /^I said 42\./, "it knows what it answered before");
});

test("a subagent works in the mode of its chat, with its instructions; with the setting off, in Standard", { timeout: 60_000 }, async () => {
  const mode = db.createCustomMode({ label: "Beacon", description: "Says something" });
  db.updateCustomMode(mode.id, { instructions: "Always mention the BEACON word." });
  const moded = `custom/${mode.id}`;
  /** The system prompt of the child's first request, and the mode of the child chat. */
  async function delegate(parent: string) {
    db.createSession({ id: parent, title: parent, workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task", mode: moded });
    const seen = childRequests.length;
    await ask(parent, "Delegate it");
    const [child] = db.childSessions(parent);
    return { mode: child.mode, prompt: JSON.stringify(childRequests[seen].messages[0]) };
  }
  assert.equal((await put(`${portal.at}/settings`, { inheritMode: true })).status, 200);
  const same = await delegate("moded-parent");
  assert.equal(same.mode, moded);
  assert.match(same.prompt, /BEACON/, "the child chat's pi is told the mode's instructions");

  assert.equal((await put(`${portal.at}/settings`, { inheritMode: false })).status, 200);
  const standard = await delegate("moded-parent-2");
  assert.equal(standard.mode, null);
  assert.doesNotMatch(standard.prompt, /BEACON/);
  await put(`${portal.at}/settings`, { inheritMode: true });
});

test("a subagent does not get past the tools its chat's mode switched off, with the setting off or on, and works at its chat's effort", { timeout: 60_000 }, async () => {
  const mode = db.createCustomMode({ label: "Review only", description: "Cannot change the folder" });
  db.updateCustomMode(mode.id, { thinking_level: "high" });
  db.setCustomModeTools(mode.id, { off: ["bash", "write"], on: [] });
  const reviewing = `custom/${mode.id}`;
  /** The child chat's row, and the tools its pi was told it has. */
  async function delegate(parent: string) {
    // The person lowered the chat's effort after it was put in the mode.
    db.createSession({ id: parent, title: parent, workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task", mode: reviewing, thinking_level: "low" });
    const seen = childRequests.length;
    await ask(parent, "Delegate it");
    const [child] = db.childSessions(parent);
    return { child: db.getSession(child.id), tools: childRequests[seen].tools.map((tool: any) => tool.function?.name) };
  }
  try {
    assert.equal((await put(`${portal.at}/settings`, { inheritMode: false })).status, 200);
    const standard = await delegate("review-off");
    assert.equal(standard.child.mode, null);
    assert.ok(standard.tools.includes("read"), "the rest of Standard is declared");
    assert.ok(!standard.tools.includes("bash") && !standard.tools.includes("write"), "what the chat's mode took away is not");

    assert.equal((await put(`${portal.at}/settings`, { inheritMode: true })).status, 200);
    const same = await delegate("review-on");
    assert.equal(same.child.mode, reviewing);
    assert.ok(!same.tools.includes("bash") && !same.tools.includes("write"));
    assert.equal(same.child.thinking_level, "low", "the chat's effort, not the mode's");
  } finally {
    await put(`${portal.at}/settings`, { inheritMode: true });
  }
});

test("a subagent that read outside content marks its chat for good: the mark is in the chat's history, and holds when the chat's guard is made again", { timeout: 60_000 }, async () => {
  for (const mode of ["interrupt", "background"]) {
    assert.equal((await put(`${portal.at}/settings`, { mode })).status, 200);
    const parent = `marked-${mode}`;
    db.createSession({ id: parent, title: parent, workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
    marking = parent;
    relayed = false;
    try {
      const first = await ask(parent, "Delegate it");
      if (mode === "background") {
        await until(() => relayed, "the answer to reach the chat");
        await until(() => db.getSession(parent).status === "idle", "the chat to be idle again");
      }
      assert.equal(sessionTainted(parent), true, "the portal marked the chat as the answer came back");
      if (mode === "interrupt") assert.deepEqual(flaggedResult(first)?.signals, ["came from a subagent that read outside content"], "and its result says so");
    } finally {
      marking = "";
    }

    // Its pi goes, and the next one has a guard that knows only what the history says.
    await sessions.stop(parent);
    assert.equal(sessionTainted(parent), false, "no guard, no mark in memory");
    await ask(parent, "Hello");
    assert.equal(sessionTainted(parent), true, `${mode}: the chat is still marked`);
  }
  assert.equal((await put(`${portal.at}/settings`, { mode: "interrupt" })).status, 200);
});
