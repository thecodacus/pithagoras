import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// Where some tools are not what the default says: the chats and the routines that have them otherwise, for any
// tools by name (`portal.tools.exceptions`), as a page that says who may use them asks.
const home = inProcessHome("pithagoras-tool-exceptions-");

const db = await import("../dist/db.js");
const host = await import("../dist/extension-host.js");
test.after(() => host.stopServerHalves());

// A package's two tools, which go together, as a browser's do.
const BROWSER = ["browser_click", "browser_navigate"];
db.rememberTools([
  ...BROWSER.map((name) => db.remembered({ name, source: "pithagoras-browser", inline: true })),
  db.remembered({ name: "paint", source: "painter", inline: true }),
]);
const project = path.join(process.env.WORKSPACE_ROOT, "alpha");
mkdirSync(project, { recursive: true });
const chat = (id, workspace = home) => db.createSession({ id, title: `Chat ${id}`, workspace, executor: "host" });
chat("plain");
chat("browser-off");
db.setSessionTools("browser-off", { off: BROWSER, on: [] });
chat("paint-off");
db.setSessionTools("paint-off", { off: ["paint"], on: [] });
// A project that switches the browser off for its chats, which say nothing themselves.
chat("in-alpha", project);
db.setProjectTools("alpha", { off: BROWSER, on: [] });
const routine = (slug, { off = "", on = "", workspace = null } = {}) =>
  db
    .getDb()
    .prepare("INSERT INTO routines (id, slug, name, tools_off, tools_on, workspace) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`id-${slug}`, slug, `Routine ${slug}`, off, on, workspace);
// The browser's tools, switched on by one routine and off by another; a third says nothing of them.
routine("drives", { on: BROWSER.join("\n") });
routine("stays-off", { off: BROWSER.join("\n") });
routine("says-nothing");
routine("no-paint", { off: "paint" });
// Each switches paint on: in Home, where it is on already, and in alpha.
routine("home-paint", { on: "paint" });
routine("alpha-paint", { on: "paint", workspace: project });

const ids = (rows) => rows.map((row) => row.id).sort();

test("tools differ in the chats that switch them, and in those of a project that does, by default on and by default off", () => {
  for (const off of [[], BROWSER]) {
    db.setToolDefaultsOff(off);
    const asked = db.toolExceptions(BROWSER);
    assert.equal(asked.byDefault, off.length === 0, `default off: ${off.join(", ")}`);
    // Off by default, no chat has them on: none says so.
    assert.deepEqual(ids(asked.chats), off.length ? [] : ["browser-off", "in-alpha"], `default off: ${off.join(", ")}`);
  }
  db.setToolDefaultsOff([]);
});

test("a routine is listed where its own lists give its runs another answer than a routine that sets nothing, with that answer", () => {
  // On by default, the routine that switches them off is listed; off by default, the one that switches them on.
  for (const [off, routines] of [
    [[], [{ slug: "stays-off", name: "Routine stays-off", allowed: false }]],
    [BROWSER, [{ slug: "drives", name: "Routine drives", allowed: true }]],
  ]) {
    db.setToolDefaultsOff(off);
    assert.deepEqual(db.toolExceptions(BROWSER).routines, routines, `default off: ${off.join(", ")}`);
  }
  db.setToolDefaultsOff([]);
  // Any tool, by the routine's lists, against what its place has: paint is on in Home, and off in alpha.
  db.setProjectTools("alpha", { off: [...BROWSER, "paint"], on: [] });
  try {
    const paint = db.toolExceptions(["paint"]);
    assert.equal(paint.byDefault, true);
    assert.deepEqual(ids(paint.chats), ["in-alpha", "paint-off"]);
    assert.deepEqual(paint.routines, [
      { slug: "alpha-paint", name: "Routine alpha-paint", allowed: true },
      { slug: "no-paint", name: "Routine no-paint", allowed: false },
    ]);
  } finally {
    db.setProjectTools("alpha", { off: BROWSER, on: [] });
  }
  // With alpha saying nothing of paint, the routine there switches it on where it is on already.
  assert.deepEqual(db.toolExceptions(["paint"]).routines, [{ slug: "no-paint", name: "Routine no-paint", allowed: false }]);
  // None named is on nowhere.
  assert.deepEqual(db.toolExceptions([]), { byDefault: false, chats: [], routines: [] });
});

test("a server half asks for any tools by name, and is told the chats and routines that differ", async () => {
  const dir = path.join(home, "packages", "painter");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, "export default function (portal) { globalThis.painter = portal; }\n");
  await host.syncServerHalves([{ name: "painter", version: "1.0.0", file, rev: `${statSync(file).size}` }]);
  const portal = globalThis.painter;
  assert.deepEqual(portal.tools.exceptions(["paint"]), {
    byDefault: true,
    chats: [{ id: "paint-off", title: "Chat paint-off", kind: "task" }],
    routines: [{ slug: "no-paint", name: "Routine no-paint", allowed: false }],
  });
  assert.deepEqual(portal.tools.exceptions([]), { byDefault: false, chats: [], routines: [] });
  assert.throws(() => portal.tools.exceptions("paint"), /exceptions takes a list of tool names/);
  assert.throws(() => portal.tools.exceptions([1]), /exceptions takes a list of tool names/);
});

test("the run of a routine that is gone has what the layers under it say, and its own switches: the routine's layer went with it", () => {
  const run = (id, tools) => {
    db.createSession({ id, title: `Run ${id}`, workspace: home, executor: "host", kind: "routine", routine_slug: "deleted-one" });
    db.setSessionTools(id, tools);
  };
  // One switched one of the tools off, and has the other; one switched both off.
  run("gone-one-off", { off: ["browser_click"], on: [] });
  run("gone-both-off", { off: BROWSER, on: [] });
  assert.deepEqual(ids(db.toolExceptions(BROWSER).chats), ["browser-off", "gone-both-off", "in-alpha"]);
});
