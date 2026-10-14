import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * How long ask_question waits (issue #114), against the whole server: the opt-in setting the Tools page reads
 * and writes, and which pages list the tool.
 */
const home = inProcessHome("pithagoras-ask-question-api-");
mkdirSync(path.join(home, "ws", "research"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({}));

const db = await import("../dist/db.js");
// As a browser chat leaves it behind once it has run.
db.rememberTools([
  { name: "ask_question", source: "ask-question", package: null, inline: true },
  { name: "bash", source: "built in", package: null },
]);

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (url, method = "GET", body) => {
  const res = await send(url, method, body);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const names = (r) => r.tools.map((t) => t.name);

test("a question waits until it is answered unless the setting says otherwise, and the setting takes only the offered minutes", async () => {
  assert.equal((await json("/api/tools")).questionWaitMinutes, 0, "until answered by default");
  assert.equal(db.questionWaitMs(), 0);

  for (const bad of [-1, 7, "15", null, 1.5, undefined]) {
    const res = await send("/api/ask-question", "PUT", { waitMinutes: bad });
    assert.equal(res.status, 400, String(bad));
  }
  assert.equal((await json("/api/tools")).questionWaitMinutes, 0, "a refused value changes nothing");

  assert.deepEqual(await json("/api/ask-question", "PUT", { waitMinutes: 15 }), { waitMinutes: 15 });
  assert.equal((await json("/api/tools")).questionWaitMinutes, 15);
  assert.equal(db.questionWaitMs(), 15 * 60_000, "read when a question is asked");

  await json("/api/ask-question", "PUT", { waitMinutes: 0 });
  assert.equal(db.questionWaitMs(), 0);
});

test("a project's chats and an agent's pages are offered the tool in their lists, a routine's page is not", async () => {
  assert.ok(names(await json("/api/tools")).includes("ask_question"));
  const chat = await json("/api/sessions", "POST", { workspace: "research" });
  assert.ok(names(await json(`/api/sessions/${chat.id}/tools`)).includes("ask_question"));

  const agent = await json("/api/agents", "POST", { name: "Reader" });
  assert.deepEqual(names(await json(`/api/agents/${agent.id}/tools`)), ["ask_question", "bash"]);
  const routine = await json("/api/routines", "POST", { name: "Nightly", schedule: "0 9 * * *", instructions: "Do it" });
  assert.deepEqual(names(await json(`/api/routines/${routine.id}/tools`)), ["bash"]);
});
