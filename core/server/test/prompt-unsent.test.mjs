import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * A message that a Stop got to while pi was still starting, against the whole
 * server: it goes back to the person as not sent, and a chat it was the start
 * of is not named after it.
 */
const home = inProcessHome("pithagoras-unsent-");

// pi is not up until the test says so. How long it takes to start is the server's
// own business, and a Stop that has to land inside that time was a race: an
// extension that waits for a file keeps pi in its start for as long as the test wants.
const go = path.join(home, "go");
mkdirSync(path.join(home, "agent", "extensions"), { recursive: true });
writeFileSync(path.join(home, "agent", "extensions", "slow-start.ts"), `
import { existsSync } from "node:fs";
export default async function () {
  for (let i = 0; i < 3000 && !existsSync(${JSON.stringify(go)}); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}
`);

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const json = async (url, init) => {
  const res = await fetch(base + url, { ...init, headers: { "Content-Type": "application/json" } });
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};

test("a message stopped while pi was starting is answered as not sent, and does not name the chat", async () => {
  const chat = await json("/api/sessions", { method: "POST", body: "{}" });
  assert.equal(chat.auto_title, 1);

  const sending = json(`/api/sessions/${chat.id}/prompt`, { method: "POST", body: JSON.stringify({ message: "delete all branches except main" }) });
  // The chat shows as working from the moment the message is in, while pi is
  // still starting: that is where the person presses Stop.
  for (let i = 0; (await json(`/api/sessions/${chat.id}`)).status !== "running"; i++) {
    assert.ok(i < 200, "the chat never showed as working");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(go), false, "pi is still held in its start");
  await json(`/api/sessions/${chat.id}/abort`, { method: "POST" });
  writeFileSync(go, "");

  const answer = await sending;
  assert.deepEqual(answer, { ok: true, unsent: true });
  const after = await json(`/api/sessions/${chat.id}`);
  assert.equal(after.title, "New chat", "not called after words that were never sent");
  assert.equal(after.auto_title, 1, "and still waiting for a name");
  assert.equal(after.status, "idle");
});
