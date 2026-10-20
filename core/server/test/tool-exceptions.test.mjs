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
  ...BROWSER.map((name) => db.remembered({ name, source: "browser", inline: true })),
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
const routine = (slug, { browser = 0, off = "", on = "", workspace = null } = {}) =>
  db
    .getDb()
    .prepare("INSERT INTO routines (id, slug, name, browser, tools_off, tools_on, workspace) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`id-${slug}`, slug, `Routine ${slug}`, browser, off, on, workspace);
// A routine's old Browser switch answers for the browser's tools its lists do not name, and is off for a new one.
routine("drives", { browser: 1 });
routine("stays-off");
routine("no-paint", { off: "paint" });
// Each switches paint on: in Home, where it is on already, and in alpha.
routine("home-paint", { on: "paint" });
routine("alpha-paint", { on: "paint", workspace: project });

const ids = (rows) => rows.map((row) => row.id).sort();
const slugs = (rows) => rows.map((row) => row.slug).sort();

test("the browser's tools differ where the Browser page has always said they do, by default on and by default off", () => {
  for (const off of [[], BROWSER]) {
    db.setToolDefaultsOff(off);
    const asked = db.toolExceptions(db.seenBrowserTools());
    const page = db.toolsDifferWith(db.browserPolicy());
    assert.equal(asked.byDefault, page.byDefault, `default off: ${off.join(", ")}`);
    assert.deepEqual(ids(asked.chats), ids(page.chats), `default off: ${off.join(", ")}`);
  }
  db.setToolDefaultsOff([]);
  assert.deepEqual(ids(db.toolExceptions(BROWSER).chats), ["browser-off", "in-alpha"]);
});

test("a routine is listed where its own switch or lists give its runs another answer than a routine that sets nothing, with that answer", () => {
  // A routine that sets nothing has the browser's tools off, whatever a chat has by default: the one whose switch is
  // on is listed, by default on and by default off, and the one that sets nothing is not.
  for (const off of [[], BROWSER]) {
    db.setToolDefaultsOff(off);
    const asked = db.toolExceptions(BROWSER);
    assert.equal(asked.byDefault, off.length === 0);
    assert.deepEqual(asked.routines, [{ slug: "drives", name: "Routine drives", allowed: true }], `default off: ${off.join(", ")}`);
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
    routines: [{ slug: "no-paint", name: "Routine no-paint", allowed: false }],
  });
  assert.deepEqual(portal.tools.exceptions([]), { byDefault: false, chats: [], routines: [] });
  assert.throws(() => portal.tools.exceptions("paint"), /exceptions takes a list of tool names/);
  assert.throws(() => portal.tools.exceptions([1]), /exceptions takes a list of tool names/);
});

test("the Browser page is told the same: each chat with the other answer, and the routines its old list had, with theirs", async () => {
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
    assert.deepEqual(page.routines, [{ slug: "drives", name: "Routine drives", allowed: true }]);
    // The routines the page listed before it asked as any tools are asked: those whose switch is on.
    const before = db.getDb().prepare("SELECT slug FROM routines WHERE browser = 1").all();
    assert.deepEqual(slugs(page.routines), slugs(before));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
