import assert from "node:assert/strict";
import test from "node:test";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/** A portal that cannot switch tools says so with a code, so that the page does not take any other failure for it. */
const home = testHome("tools-unsupported-");
const { base } = await startServer(serverEnv(home, await freePort(), { EXECUTOR: "container" }));

test("the portal-wide tool list is refused with a code when pi runs in a container", async () => {
  const res = await fetch(`${base}/api/tools`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "tools-unsupported");
  assert.match(body.error, /EXECUTOR=container/);
});

test("so is a project's list, the write, and a project made with tools of its own", async () => {
  const json = { "content-type": "application/json" };
  const made = await fetch(`${base}/api/projects`, { method: "POST", headers: json, body: JSON.stringify({ name: "notes" }) });
  assert.equal(made.status, 200, await made.clone().text());
  const list = await fetch(`${base}/api/projects/notes/tools`);
  assert.equal(list.status, 400);
  assert.equal((await list.json()).code, "tools-unsupported");
  const put = await fetch(`${base}/api/tools`, { method: "PUT", headers: json, body: JSON.stringify({ off: [] }) });
  assert.equal(put.status, 400);
  assert.equal((await put.json()).code, "tools-unsupported");
  const withTools = await fetch(`${base}/api/projects`, { method: "POST", headers: json, body: JSON.stringify({ name: "other", toolsOff: ["a"] }) });
  assert.equal(withTools.status, 400);
  assert.equal((await withTools.json()).code, "tools-unsupported");
});

test("a chat is offered no mode, and putting one in a mode is refused, when pi runs in a container", async () => {
  const json = { "content-type": "application/json" };
  const made = await fetch(`${base}/api/sessions`, { method: "POST", headers: json, body: JSON.stringify({}) });
  assert.equal(made.status, 200, await made.clone().text());
  const { id } = await made.json();
  const list = await fetch(`${base}/api/sessions/${id}/modes`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { modes: [] });
  const put = await fetch(`${base}/api/sessions/${id}/modes`, { method: "PUT", headers: json, body: JSON.stringify({ mode: "code" }) });
  assert.equal(put.status, 409);
  assert.deepEqual(await put.json(), { error: "Modes are for the chats you start on the portal's pages, where pi runs in the portal's own process." });
});

test("so are the modes the person makes, which are tool layers too", async () => {
  const res = await fetch(`${base}/api/chat-modes`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "tools-unsupported");
});
