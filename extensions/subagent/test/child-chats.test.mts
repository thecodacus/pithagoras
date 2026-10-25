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
const childRequests: any[] = [];
const model = await fakeModel((request: any) => {
  const tools = (request.tools ?? []).map((tool: any) => tool.function?.name);
  const last = request.messages.at(-1);
  const said = JSON.stringify(last?.content ?? "");
  if (tools.includes("subagent")) {
    if (last?.role === "tool") return "Done.";
    if (said.includes("Delegate")) return { name: "subagent", args: { task: "Answer the riddle", label: "Riddle" } };
    if (said.includes("Again")) return { name: "subagent", args: { id: childId, task: "What did you answer?" } };
    return "Done.";
  }
  childRequests.push(request);
  if (said.includes("riddle")) return "The answer is 42.";
  if (said.includes("What did you answer")) return JSON.stringify(request.messages).includes("The answer is 42") ? "I said 42." : "I do not know.";
  return "Done.";
});
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify(model.models()));

const dist = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;
const db = await import(dist("db.js"));
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
