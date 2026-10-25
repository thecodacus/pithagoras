import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * An extension that holds the agent's memory (`portal.memory.hold`): while it does, a chat with the person does not
 * read MEMORY.md and is told the extension's rule in its place; a project linked to an agent can do without it; the
 * agent's setup and the portal's flags say which holds it. The first that asks holds it.
 */
const home = inProcessHome("extension-memory-");
const said = [];
const log = console.log;
console.log = (...args) => {
  said.push(args.join(" "));
  log(...args);
};
test.after(() => (console.log = log));

const { memoryHolder } = await import("../dist/memory-holder.js");
const host = await import("../dist/extension-host.js");
const { extraContextFiles, memoryRule } = await import("../dist/pi/sdk-client.js");
const { memoryHeldAt } = await import("../dist/project-agent.js");
const { agentFileStatus } = await import("../dist/agent-setup.js");
const { createAgent } = await import("../dist/agents.js");
const { setProjectAgent } = await import("../dist/db.js");
const { featuresRouter } = await import("../dist/api/features.js");
const { default: express } = await import("express");
test.after(() => host.stopServerHalves());

const app = express().use("/api", featuresRouter());
const listener = app.listen(0, "127.0.0.1");
await new Promise((resolve) => listener.once("listening", resolve));
test.after(() => listener.close());
const flags = async () => (await fetch(`http://127.0.0.1:${listener.address().port}/api/features/flags`)).json();

let revs = 0;
/** A server half that says it holds the memory while `globalThis.holding[name]` is true. */
function keeper(name, label) {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `server-${++revs}.js`);
  writeFileSync(file, `export default function (portal) {\nportal.memory.hold({ label: ${JSON.stringify(label)}, rule: "Your memory is ${label}'s, not MEMORY.md.", on: () => globalThis.holding[${JSON.stringify(name)}] });\nglobalThis.portals[${JSON.stringify(name)}] = portal;\n}\n`);
  return { name, version: "1.0.0", file, rev: `${statSync(file).size.toString(36)}-${revs}` };
}
globalThis.holding = {};
globalThis.portals = {};

const nova = createAgent({ name: "Nova" });
for (const f of ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]) writeFileSync(path.join(nova.home, f), `# ${f} of Nova`);
const names = (cwd, role) => extraContextFiles(cwd, role).map((f) => path.basename(f.path)).sort();
const project = (name, link) => {
  const dir = path.join(process.env.WORKSPACE_ROOT, name);
  mkdirSync(dir, { recursive: true });
  setProjectAgent(name, link);
  return dir;
};

test("while an extension holds the memory, MEMORY.md is not read and its rule is said in its place; while it does not, the file is the memory", async () => {
  await host.syncServerHalves([keeper("keeper", "Keeper")]);
  assert.deepEqual(names(nova.home), ["MEMORY.md", "PrimaryUser.md", "SOUL.md"]);
  assert.deepEqual(memoryRule(nova.home), []);
  assert.equal(agentFileStatus(nova.home).memory, "file");
  assert.equal(agentFileStatus(nova.home).by, null);
  assert.deepEqual((await flags()).memory, { held: false, by: null });

  globalThis.holding.keeper = true;
  assert.deepEqual(names(nova.home), ["PrimaryUser.md", "SOUL.md"]);
  assert.deepEqual(names(nova.home, "primary"), ["PrimaryUser.md", "SOUL.md"]);
  assert.deepEqual(memoryRule(nova.home), ["Your memory is Keeper's, not MEMORY.md."]);
  // Someone who is not the person never read MEMORY.md, and is not told of a memory that replaces it.
  assert.deepEqual(memoryRule(nova.home, "guest"), []);
  assert.deepEqual({ memory: agentFileStatus(nova.home).memory, by: agentFileStatus(nova.home).by }, { memory: "extension", by: "Keeper" });
  assert.deepEqual(await flags(), { memory: { held: true, by: "Keeper" } });

  globalThis.holding.keeper = false;
  assert.deepEqual(names(nova.home), ["MEMORY.md", "PrimaryUser.md", "SOUL.md"]);
});

test("a project linked to an agent has the memory unless it does without it; a blank project never has it", async () => {
  globalThis.holding.keeper = true;
  const linked = project("linked", { agent: nova.id, memoryOff: false });
  assert.equal(memoryHeldAt(linked)?.label, "Keeper");
  assert.deepEqual(names(linked), ["PrimaryUser.md", "SOUL.md"]);
  assert.equal(memoryRule(linked).length, 1);

  const without = project("without", { agent: nova.id, memoryOff: true });
  assert.equal(memoryHeldAt(without), undefined);
  assert.deepEqual(names(without), ["MEMORY.md", "PrimaryUser.md", "SOUL.md"]);
  assert.deepEqual(memoryRule(without), []);
  // Only that project: the agent's home still has it.
  assert.equal(memoryHeldAt(nova.home)?.label, "Keeper");

  const blank = project("blank", { agent: "", memoryOff: false });
  assert.equal(memoryHeldAt(blank), undefined);
  assert.deepEqual(memoryRule(blank), []);
  globalThis.holding.keeper = false;
});

test("the first extension that asks holds the memory: one that asks while it does is refused, and it is let go when its half stops", async () => {
  globalThis.holding = { keeper: true, rival: true };
  said.length = 0;
  const [first, second] = [keeper("keeper", "Keeper"), keeper("rival", "Rival")];
  await host.syncServerHalves([first, second]);
  assert.ok(said.includes("[portal] rival cannot hold the agent's memory: keeper holds it already, as Keeper"), said.join("\n"));
  assert.equal(memoryHolder()?.label, "Keeper");

  // The first stopped: nothing holds it. The one refused holds nothing, until it starts again and asks again.
  await host.syncServerHalves([second]);
  assert.equal(memoryHolder(), undefined);
  assert.deepEqual(names(nova.home), ["MEMORY.md", "PrimaryUser.md", "SOUL.md"]);
  await host.syncServerHalves([]);
  await host.syncServerHalves([second]);
  assert.equal(memoryHolder()?.label, "Rival");
  await host.syncServerHalves([]);
  assert.equal(memoryHolder(), undefined);
});

test("what an extension says of itself is its own: one whose answer fails, or is anything but true, holds nothing, and a hold without a label, a rule and `on` throws", async () => {
  const dir = path.join(home, "packages", "odd");
  mkdirSync(dir, { recursive: true });
  // A promise is no answer, however it settles: it would hold the memory for good.
  for (const [i, on] of ['() => { throw new Error("no idea"); }', "async () => true", '() => "yes"'].entries()) {
    const file = path.join(dir, `server-${i}.js`);
    writeFileSync(file, `export default function (portal) {\nglobalThis.portals.odd = portal;\nportal.memory.hold({ label: "Odd", rule: "Odd's rule.", on: ${on} });\n}\n`);
    await host.syncServerHalves([{ name: "odd", version: "1.0.0", file, rev: `${statSync(file).size.toString(36)}-${i}` }]);
    assert.equal(memoryHolder(), undefined, on);
    assert.deepEqual(names(nova.home), ["MEMORY.md", "PrimaryUser.md", "SOUL.md"], on);
  }
  for (const holder of [undefined, { label: "", rule: "r", on: () => true }, { label: "l", rule: 3, on: () => true }, { label: "l", rule: "r", on: true }]) {
    assert.throws(() => globalThis.portals.odd.memory.hold(holder), /hold takes \{ label, rule, on \}/);
  }
  await host.syncServerHalves([]);
});

test("a half that asks once it is no longer running holds nothing: its start gave up, or it was stopped", async () => {
  said.length = 0;
  const dir = path.join(home, "packages", "late");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  // Its start goes on after the host gave up on it, and asks then.
  writeFileSync(file, `export default async function (portal) {\nglobalThis.portals.late = portal;\nawait new Promise((resolve) => setTimeout(resolve, 400));\nportal.memory.hold({ label: "Late", rule: "Late's rule.", on: () => true });\n}\n`);
  host.setLimits(100, 100);
  try {
    await host.syncServerHalves([{ name: "late", version: "1.0.0", file, rev: statSync(file).size.toString(36) }]);
  } finally {
    host.setLimits(15_000, 5_000);
  }
  assert.equal(host.isServing("late"), false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(memoryHolder(), undefined);
  assert.deepEqual(names(nova.home), ["MEMORY.md", "PrimaryUser.md", "SOUL.md"]);
  assert.ok(said.includes("[extension late] cannot hold the agent's memory: its server half is not running"), said.join("\n"));

  // Stopped, and asking from a timer it left behind.
  globalThis.holding.keeper = true;
  const once = path.join(dir, "once.js");
  writeFileSync(once, "export default function (portal) {\nglobalThis.portals.once = portal;\n}\n");
  await host.syncServerHalves([{ name: "once", version: "1.0.0", file: once, rev: statSync(once).size.toString(36) }]);
  await host.syncServerHalves([]);
  globalThis.portals.once.memory.hold({ label: "Once", rule: "Once's rule.", on: () => true });
  assert.equal(memoryHolder(), undefined);
  // Nothing was left held: one that runs now has it.
  await host.syncServerHalves([keeper("keeper", "Keeper")]);
  assert.equal(memoryHolder()?.label, "Keeper");
  await host.syncServerHalves([]);
  globalThis.holding.keeper = false;
});
