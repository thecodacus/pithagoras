import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import express from "express";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-people-api-");

const { peopleRouter } = await import("../dist/api/people.js");
const { getPerson, hasPrimary, seen, setRole } = await import("../dist/people.js");
const { guardExtension } = await import("../dist/pi/guard.js");

const app = express();
app.use(express.json());
app.use("/api", peopleRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

const person = (key, role, name = key) => {
  seen(key, name);
  setRole(key, role);
};

test("taking the last primary user away is refused unless it was asked for as that, by a role change and by forgetting alike", async () => {
  person("tg:owner", "primary", "Sam");
  person("tg:kim", "colleague", "Kim");

  const demote = await call("PATCH", "/people/tg%3Aowner", { role: "colleague" });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.code, "last-primary");
  assert.match(demote.body.error, /only primary user/);
  assert.equal(getPerson("tg:owner").role, "primary", "nothing changed");

  const forget = await call("DELETE", "/people/tg%3Aowner");
  assert.equal(forget.status, 409);
  assert.equal(forget.body.code, "last-primary");
  assert.ok(getPerson("tg:owner"));
  assert.equal(hasPrimary(), true);

  // Not the last: the role moves to somebody else, and a plain colleague is just forgotten.
  assert.equal((await call("PATCH", "/people/tg%3Akim", { role: "guest" })).status, 200);
  assert.equal((await call("PATCH", "/people/tg%3Akim", { role: "primary" })).status, 200, "promoting demotes the one who held it");
  assert.equal(getPerson("tg:owner").role, "colleague");
  assert.equal((await call("PATCH", "/people/tg%3Aowner", { role: "guest" })).status, 200, "no longer a primary user");
  assert.equal((await call("DELETE", "/people/tg%3Aowner")).status, 200);

  // The one left, on purpose.
  assert.equal((await call("DELETE", "/people/tg%3Akim?force=1")).status, 200);
  assert.equal(getPerson("tg:kim"), undefined);
  assert.equal(hasPrimary(), false);
});

test("a name set by hand stays through the person's next message, with or without notes", async () => {
  seen("tg:tg_user_8812", "tg_user_8812");
  const done = await call("PATCH", "/people/tg%3Atg_user_8812", { name: "Sam (accountant)" });
  assert.equal(done.body.person.name, "Sam (accountant)");
  assert.equal(seen("tg:tg_user_8812", "Alice (CTO)").name, "Sam (accountant)");
  const again = await call("PATCH", "/people/tg%3Atg_user_8812", { name: "  " });
  assert.equal(again.body.person.name, "Sam (accountant)", "a blank name is not a rename");
});

test("a rule cannot be written for a tool that would run what they write as the primary user", async () => {
  person("tg:priya", "colleague", "Priya");
  const before = (await call("GET", "/tool-rules")).body.rules.length;
  for (const tool of ["subagent", "routine_create", "routine_update", "routine_run"]) {
    for (const role of ["colleague", "guest", "all"]) {
      const refused = await call("POST", "/tool-rules", { role, tool, pattern: "{*", personKey: "tg:priya" });
      assert.equal(refused.status, 400, `${role}: ${tool}`);
      assert.match(refused.body.error, new RegExp(`^A rule cannot allow ${tool}: `));
    }
  }
  assert.equal((await call("GET", "/tool-rules")).body.rules.length, before, "none was written");
  const other = await call("POST", "/tool-rules", { role: "colleague", tool: "web_search", pattern: "{*" });
  assert.equal(other.status, 200, "a tool that runs nothing as them is not held");
  await call("DELETE", `/tool-rules/${other.body.rules.find((r) => r.tool === "web_search").id}`);
});

test("a rule for one person is allowed for anybody whatever their role, applies to them after a role change, and comes back in one shape", async () => {
  person("tg:priya", "guest", "Priya");
  // One written while she was a guest, as the page used to write them, and one as it does now.
  assert.equal((await call("POST", "/tool-rules", { role: "guest", tool: "bash", pattern: "echo guest", personKey: "tg:priya" })).status, 200);
  assert.equal((await call("POST", "/tool-rules", { role: "all", tool: "bash", pattern: "echo anyone", personKey: "tg:priya" })).status, 200, "also for a primary or a blocked person, who have no role of their own to write it for");
  const listed = await call("GET", "/tool-rules");
  assert.equal(listed.body.rules.length, 2);
  for (const rule of listed.body.rules) assert.ok(!("person_name" in rule), "no field only one route has");
  const added = await call("POST", "/tool-rules", { role: "all", tool: "bash", pattern: "echo more", personKey: "tg:priya" });
  assert.deepEqual(Object.keys(added.body.rules[0]).sort(), Object.keys(listed.body.rules[0]).sort());
  const removed = await call("DELETE", `/tool-rules/${added.body.rules.find((r) => r.pattern === "echo more").id}`);
  assert.deepEqual(Object.keys(removed.body.rules[0]).sort(), Object.keys(listed.body.rules[0]).sort());

  // Written for a guest, then she is made a colleague: the guard still lets it through, for her.
  const rules = listed.body.rules;
  const guard = (role, key) => {
    const h = {};
    guardExtension("t", () => ({ role, key }), "s", true, () => ({ allowed: true, allowlist: [] }))({ on: (k, f) => (h[k] = f) });
    return h;
  };
  const rule = rules.find((r) => r.role === "guest" && r.person_key === "tg:priya");
  assert.ok(rule);
  assert.equal(guard("colleague", "tg:priya").tool_call({ toolName: "bash", input: { command: "echo guest" } }), undefined, "after being made a colleague");
  assert.equal(guard("guest", "tg:priya").tool_call({ toolName: "bash", input: { command: "echo guest" } }), undefined);
  assert.equal(guard("primary", "tg:priya").tool_call({ toolName: "bash", input: { command: "echo anyone" } }), undefined);
  assert.equal(guard("unknown", "tg:priya").tool_call({ toolName: "bash", input: { command: "echo anyone" } }), undefined, "a person's rule is hers whatever she is");
  assert.equal(guard("colleague", "tg:sam").tool_call({ toolName: "bash", input: { command: "echo guest" } })?.block, true, "not for anyone else");
});
