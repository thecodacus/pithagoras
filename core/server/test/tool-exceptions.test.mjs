import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// Where some tools are not what the default says: the chats and the routines that have them otherwise, for any
// tools by name (`portal.tools.exceptions`), worked out as the Browser page's "Who may drive it" is.
const home = inProcessHome("pithagoras-tool-exceptions-");
// No browser to ask and no Docker: the Browser page's answer about the browser itself is not what is tested here.
process.env.BROWSER_CDP_URL = "http://127.0.0.1:1";
process.env.DOCKER_SOCKET = path.join(home, "no-docker.sock");
process.env.BROWSER_BINARY = path.join(home, "no-chrome");

const db = await import("../dist/db.js");
const host = await import("../dist/extension-host.js");
const { default: express } = await import("express");
const { browserRouter } = await import("../dist/api/browser.js");
test.after(() => host.stopServerHalves());

const BROWSER = ["browser_click", "browser_navigate"];
db.rememberTools([
  ...BROWSER.map((name) => db.remembered({ name, source: "browser", inline: true, drivesBrowser: true })),
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
const routine = (slug, browser, toolsOff = "") =>
  db.getDb().prepare("INSERT INTO routines (id, slug, name, browser, tools_off) VALUES (?, ?, ?, ?, ?)").run(`id-${slug}`, slug, `Routine ${slug}`, browser, toolsOff);
// A routine's old Browser switch answers for the browser's tools its lists do not name.
routine("drives", 1);
routine("stays-off", 0);
routine("no-paint", 0, "paint");

const ids = (rows) => rows.map((row) => row.id).sort();
const slugs = (rows) => rows.map((row) => row.slug).sort();

test("the browser's tools differ where the Browser page has always said they do, by default on and by default off", () => {
  for (const off of [[], BROWSER]) {
    db.setToolDefaultsOff(off);
    const asked = db.toolExceptions(db.seenBrowserTools());
    assert.equal(asked.byDefault, db.browserByDefault(), `default off: ${off.join(", ")}`);
    assert.deepEqual(ids(asked.chats), ids(db.browserExceptions()), `default off: ${off.join(", ")}`);
  }
  db.setToolDefaultsOff([]);
  assert.deepEqual(ids(db.toolExceptions(BROWSER).chats), ["browser-off", "in-alpha"]);
});

test("a routine differs where its runs have the tools otherwise: by its old switch for the browser's, and by its lists", () => {
  // On by default: the routines that keep the browser off, as each does until its switch is on.
  assert.deepEqual(slugs(db.toolExceptions(BROWSER).routines), ["no-paint", "stays-off"]);
  db.setToolDefaultsOff(BROWSER);
  // Off by default: the one that has it.
  const off = db.toolExceptions(BROWSER);
  assert.equal(off.byDefault, false);
  assert.deepEqual(slugs(off.routines), ["drives"]);
  assert.deepEqual(off.routines.find((r) => r.slug === "drives"), { slug: "drives", name: "Routine drives" });
  db.setToolDefaultsOff([]);
  // Any tool, by its lists.
  const paint = db.toolExceptions(["paint"]);
  assert.deepEqual([paint.byDefault, ids(paint.chats), slugs(paint.routines)], [true, ["paint-off"], ["no-paint"]]);
  // None named is on nowhere, whatever the browser's old column says.
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
    routines: [{ slug: "no-paint", name: "Routine no-paint" }],
  });
  assert.deepEqual(portal.tools.exceptions([]), { byDefault: false, chats: [], routines: [] });
  assert.throws(() => portal.tools.exceptions("paint"), /exceptions takes a list of tool names/);
  assert.throws(() => portal.tools.exceptions([1]), /exceptions takes a list of tool names/);
});

test("the Browser page is told the same, each one listed with the other answer", async () => {
  const app = express();
  app.use("/api", browserRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/api/browser`)).json();
    const asked = db.toolsDifferWith(db.browserPolicy());
    assert.equal(page.byDefault, true);
    assert.deepEqual(page.sessions.map((s) => s.id).sort(), ids(asked.chats));
    assert.ok(page.sessions.every((s) => s.allowed === false));
    assert.deepEqual(page.routines, [
      { slug: "no-paint", name: "Routine no-paint", allowed: false },
      { slug: "stays-off", name: "Routine stays-off", allowed: false },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
