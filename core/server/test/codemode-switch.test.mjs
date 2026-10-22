import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { freePort, inProcessHome, runToEnd, scratch, serverEnv, startServer, withoutCredentials } from "./server-harness.mjs";

/**
 * Code mode as a switch of a chat, against the whole server: off unless a
 * chat says otherwise, the chat's choice stored with the chat, and a default
 * the operator can change like any other. Held on in a chat whose mode works
 * through it.
 */
const home = inProcessHome("pithagoras-codemode-switch-");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({}));

const db = await import("../dist/db.js");
// As a session reports it: the portal's own inline extension, named for the tool.
db.rememberTools([
  { name: "codemode", source: "codemode", package: null, inline: true },
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
const codemodeOf = (r) => r.tools.find((t) => t.name === "codemode");

test("a new install starts every chat with code mode off", async () => {
  const defaults = await json("/api/tools");
  assert.deepEqual(defaults.off, ["codemode"]);
  assert.equal(codemodeOf(defaults).defaultOn, false);
  const chat = await json("/api/sessions", "POST", {});
  const tools = await json(`/api/sessions/${chat.id}/tools`);
  assert.equal(codemodeOf(tools).enabled, false);
  assert.equal(codemodeOf(tools).defaultOn, false);
  assert.equal(tools.tools.find((t) => t.name === "bash").enabled, true);
});

test("switched on in one chat, it is that chat's, kept with it, and the others keep it off", async () => {
  const chat = await json("/api/sessions", "POST", {});
  const other = await json("/api/sessions", "POST", {});
  const saved = await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: [] });
  assert.ok(!saved.off.includes("codemode"));
  assert.deepEqual(db.sessionTools(chat.id), { off: [], on: ["codemode"] });
  assert.equal(codemodeOf(await json(`/api/sessions/${chat.id}/tools`)).enabled, true);
  assert.equal(codemodeOf(await json(`/api/sessions/${other.id}/tools`)).enabled, false);
  // And off again: what the default says, so nothing is left written down.
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["codemode"] });
  assert.equal(codemodeOf(await json(`/api/sessions/${chat.id}/tools`)).enabled, false);
});

test("in a chat whose mode works through the code tool, its switch cannot turn the code tool off; a Standard chat's can", async () => {
  const chat = await json("/api/sessions", "POST", {});
  await json(`/api/sessions/${chat.id}/modes`, "PUT", { mode: "code" });
  const shown = codemodeOf(await json(`/api/sessions/${chat.id}/tools`));
  assert.deepEqual([shown.enabled, shown.byMode], [true, true]);
  const res = await send(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["bash", "codemode"] });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: "This chat's mode works through the code tool, so it stays on: start a chat in Standard mode to work without it.",
    code: "codemode-held",
  });
  // Nothing of the list was written, bash included.
  assert.deepEqual(db.sessionTools(chat.id), { off: [], on: [] });
  const after = await json(`/api/sessions/${chat.id}/tools`);
  assert.equal(codemodeOf(after).enabled, true);
  assert.equal(after.tools.find((t) => t.name === "bash").enabled, true);
  // Every other switch is the chat's as before.
  const saved = await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["bash"] });
  assert.ok(saved.off.includes("bash") && !saved.off.includes("codemode"));
  assert.deepEqual(db.sessionTools(chat.id), { off: ["bash"], on: [] });

  const plain = await json("/api/sessions", "POST", {});
  await json(`/api/sessions/${plain.id}/tools`, "PUT", { off: [] });
  assert.equal(codemodeOf(await json(`/api/sessions/${plain.id}/tools`)).byMode, undefined);
  await json(`/api/sessions/${plain.id}/tools`, "PUT", { off: ["codemode"] });
  assert.equal(codemodeOf(await json(`/api/sessions/${plain.id}/tools`)).enabled, false);
});

test("code mode cannot be marked lazy: its row says so, and a mark that names it is refused", async () => {
  // The lists offer the lazy button where a row does not say noLazy, and a mark the server did not apply would read as applied.
  const defaults = await json("/api/tools");
  assert.equal(codemodeOf(defaults).noLazy, true);
  assert.equal(codemodeOf(defaults).lazy, undefined);
  for (const mark of ["codemode", "<tool>codemode"]) {
    const res = await send("/api/tools/lazy", "PUT", { lazy: [mark] });
    assert.equal(res.status, 400, mark);
    assert.equal((await res.json()).code, "lazy-refused");
  }
  assert.deepEqual(db.lazyToolNames(), new Set());
  // Another tool of the same name is not the portal's, and may be lazy as any extension's.
  assert.equal(db.lazyAllowed({ name: "codemode", source: "pi-other", package: "pi-other", inline: false }), true);
});

test("a tool that is offered to scripts only cannot be marked lazy either: nothing would be kept out of the prompt", async () => {
  // As a session reports it (pi's `codemode` exposure): the model is never offered it, so the gateway has nothing to reach.
  db.rememberTools([
    db.remembered({ name: "scripted", source: "pi-scripts", scriptsOnly: true }),
    db.remembered({ name: "direct", source: "pi-scripts" }),
  ]);
  // The server reads what is remembered again after a write of its settings, which a report to it would have been.
  await json("/api/tools/lazy", "PUT", { lazy: [] });
  const rows = Object.fromEntries((await json("/api/tools")).tools.map((tool) => [tool.name, tool]));
  assert.equal(rows.scripted.noLazy, true, "no lazy button for its row");
  assert.equal(rows.direct.noLazy, undefined, "a tool of the same package that is offered keeps its own");
  const res = await send("/api/tools/lazy", "PUT", { lazy: ["<tool>scripted"] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "lazy-refused");
  // Its package marked lazy is the other tool's mark: it is not applied to this one, and not shown as applied.
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-scripts"] });
  const marked = Object.fromEntries((await json("/api/tools")).tools.map((tool) => [tool.name, tool]));
  assert.equal(marked.direct.lazy, true);
  assert.equal(marked.scripted.lazy, undefined);
  assert.deepEqual([...db.lazyToolNames()], ["direct"]);
  // A report that no longer says it takes the mark off: the tool is offered to the model now, and may be lazy.
  db.rememberTools([db.remembered({ name: "scripted", source: "pi-scripts" })]);
  assert.deepEqual([...db.lazyToolNames()].sort(), ["direct", "scripted"]);
  await json("/api/tools/lazy", "PUT", { lazy: [] });
  assert.equal((await json("/api/tools")).tools.find((tool) => tool.name === "scripted").noLazy, undefined);
});

const DB = fileURLToPath(new URL("../dist/db.js", import.meta.url));
/** What the default is when the portal next starts on the database in `dir`. */
async function defaultsAfterStart(dir) {
  const { code, out, err } = await runToEnd(
    ["--input-type=module", "-e", `const db = await import(${JSON.stringify(DB)}); console.log(JSON.stringify(db.toolDefaultsOff()));`],
    { ...withoutCredentials(process.env), DATA_DIR: dir },
  );
  assert.equal(code, 0, err);
  return JSON.parse(out.trim().split("\n").at(-1));
}

test("an install that had defaults keeps them, with code mode off beside them", async () => {
  const dir = scratch("pithagoras-codemode-upgrade-");
  const old = new Database(path.join(dir, "portal.db"));
  old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.prepare("INSERT INTO settings (key, value) VALUES ('tools_off_default', 'web_fetch')").run();
  old.close();
  assert.deepEqual(await defaultsAfterStart(dir), ["codemode", "web_fetch"]);
});

test("once the operator has it on by default, a later start leaves it on", async () => {
  await json("/api/tools", "PUT", { off: [] });
  assert.deepEqual(await defaultsAfterStart(home), []);
  const chat = await json("/api/sessions", "POST", {});
  assert.equal(codemodeOf(await json(`/api/sessions/${chat.id}/tools`)).enabled, true);
});
