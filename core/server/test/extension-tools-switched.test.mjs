import { before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * What an extension's server half adds to every chat's pi (`portal.chats.extend`) is listed while its package is
 * installed and switched on, as a package's own tools are: in Settings → Tools, in an agent's, a project's, a routine's
 * and a mode's lists, and in a chat that has not started. Switched off or uninstalled, it registers nothing, and its
 * tools are not listed; what somebody switched for them stays, for when it is switched on again. On and not running,
 * crashed or failed to start, they are listed as they were remembered. The portal's own inline tools are no package's,
 * and are listed whatever is switched. Against the whole server, with a real chat that reports the tools and stand-in
 * extensions installed by their folders, one of them in a process of its own.
 */
const home = inProcessHome("pithagoras-half-tools-");
mkdirSync(path.join(process.env.WORKSPACE_ROOT, "studio"), { recursive: true });
const settings = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
const model = await fakeModel(() => "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
writeFileSync(settings, JSON.stringify({ defaultProvider: "fake", defaultModel: "m", packages: [] }));
// pi, as far as the portal asks it to install, remove and list: what it installs is a folder, listed where it is. One
// switched off is listed in its settings with what it may load, under `source`.
const bin = path.join(home, "fake-bin");
mkdirSync(bin, { recursive: true });
writeFileSync(
  path.join(bin, "pi"),
  `#!${process.execPath}
const fs = require("node:fs");
const [command, spec] = process.argv.slice(2);
const file = ${JSON.stringify(settings)};
const all = JSON.parse(fs.readFileSync(file, "utf8"));
const source = (p) => (typeof p === "string" ? p : p.source);
if (command === "list") {
  process.stdout.write("User packages:\\n" + all.packages.map((p) => "  " + source(p) + "\\n    " + source(p) + "\\n").join(""));
} else if (command === "remove" || (command === "install" && !all.packages.some((p) => source(p) === spec))) {
  all.packages = all.packages.filter((p) => source(p) !== spec).concat(command === "install" ? [spec] : []);
  fs.writeFileSync(file, JSON.stringify(all));
}
`,
);
chmodSync(path.join(bin, "pi"), 0o755);

const db = await import("../dist/db.js");
// Opened here before the server opens it: the first to open the database brings its schema up to date, which a server
// that is writing meanwhile would lock this process out of.
db.getDb();

/**
 * A stand-in extension in a folder of its own, whose server half adds two tools to every chat's pi, `<prefix>_draw` and
 * `<prefix>_erase`, and has a route that crashes it. `start` is code its module runs first as it starts.
 */
function standIn(name, prefix, { isolated = false, start = "" } = {}) {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", keywords: ["pi-package"], pi: {}, pithagoras: { server: "./server.js", ...(isolated ? { isolated: true } : {}) } }));
  writeFileSync(
    path.join(dir, "server.js"),
    `export default function (portal) {
  ${start}
  const tool = (name) => ({ name, label: name, description: "Does " + name + ".", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: name + " done" }], details: {} }; } });
  portal.chats.extend((pi) => { pi.registerTool(tool(${JSON.stringify(`${prefix}_draw`)})); pi.registerTool(tool(${JSON.stringify(`${prefix}_erase`)})); });
  portal.router.post("/crash", (req, res) => { setTimeout(() => { throw new Error("crashed on purpose"); }); res.json({}); });
}
`,
  );
  return dir;
}
const sketchbook = standIn("test-sketchbook", "sketch");
const SKETCH = ["sketch_draw", "sketch_erase"];

let base;
before(async () => {
  const env = serverEnv(home, await freePort());
  ({ base } = await startServer({ ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }));
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const json = async (url, method = "GET", body) => {
  const { status, body: answer } = await call(method, url, body);
  assert.ok(status === 200, `${method} ${url}: ${status} ${JSON.stringify(answer)}`);
  return answer;
};
async function until(done, what, ms = 15_000) {
  for (const end = Date.now() + ms; !(await done()); await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
  }
}
const install = (spec) => json("/api/packages", "POST", { spec });
const uninstall = (spec) => json("/api/packages", "DELETE", { spec });
const switchTo = (spec, enabled) => json("/api/extensions/enabled", "PUT", { spec, enabled });
const standing = async (name) => (await json("/api/extension-ui")).extensions.find((ext) => ext.name === name);

/** A chat that has run, and so has its pi, which reports what it registered when its tools are opened (and the portal remembers it). */
let chat;
async function reported() {
  if (!chat) {
    chat = (await json("/api/sessions", "POST", {})).id;
    const first = model.requests.length;
    await json(`/api/sessions/${chat}/prompt`, "POST", { message: "Go on" });
    await until(() => model.requests.length > first && db.getSession(chat).status !== "running", "the chat has run");
  }
  const listed = await json(`/api/sessions/${chat}/tools`);
  assert.equal(listed.live, true);
  return listed.tools;
}

/** Of these tools, the ones each list shows, with whether each is on there: every list that shows what the portal remembers. */
let layers;
async function lists(names) {
  if (!layers) {
    const agent = (await json("/api/agents", "POST", { name: "Sketcher" })).id;
    const routine = (await json("/api/routines", "POST", { name: "Doodles", schedule: "0 9 * * *", instructions: "Draw" })).id;
    const mode = (await json("/api/chat-modes", "POST", { label: "Drawing" })).id;
    const idle = (await json("/api/sessions", "POST", {})).id;
    layers = { settings: "/api/tools", agent: `/api/agents/${agent}/tools`, project: "/api/projects/studio/tools", routine: `/api/routines/${routine}/tools`, mode: `/api/chat-modes/${mode}/tools`, idle: `/api/sessions/${idle}/tools` };
  }
  const out = {};
  for (const [layer, url] of Object.entries(layers)) {
    const answer = await json(url);
    if (layer === "idle") assert.equal(answer.live, false, "a chat that has not started is shown what the portal remembers");
    out[layer] = Object.fromEntries(answer.tools.filter((t) => names.includes(t.name)).map((t) => [t.name, layer === "settings" ? t.defaultOn : t.enabled]));
  }
  return out;
}
const everywhere = (states) => Object.fromEntries(["settings", "agent", "project", "routine", "mode", "idle"].map((layer) => [layer, states[layer] ?? states.other]));

test("switched off, a server half's tools are not listed, and their switches are kept; switched on again, they are listed as they were", async () => {
  await install(sketchbook);
  const theirs = (await reported()).filter((t) => SKETCH.includes(t.name));
  assert.deepEqual(theirs.map((t) => [t.name, t.source, t.inline]), [["sketch_draw", "test-sketchbook", true], ["sketch_erase", "test-sketchbook", true]]);
  // Remembered as the live portal remembers a server half's tools: filed under its package's name, as an inline extension's.
  assert.deepEqual(db.knownTools().filter((t) => SKETCH.includes(t.name)).map(({ name, source, package: pkg, inline }) => ({ name, source, package: pkg, inline })), [
    { name: "sketch_draw", source: "test-sketchbook", package: null, inline: true },
    { name: "sketch_erase", source: "test-sketchbook", package: null, inline: true },
  ]);

  // Off by default, and the other way round in the project.
  const { off } = await json("/api/tools");
  await json("/api/tools", "PUT", { off: [...off, "sketch_draw"] });
  const projectOff = (await json("/api/projects/studio/tools")).off;
  await json("/api/projects/studio/tools", "PUT", { off: [...projectOff.filter((name) => name !== "sketch_draw"), "sketch_erase"] });
  const switched = everywhere({ project: { sketch_draw: true, sketch_erase: false }, other: { sketch_draw: false, sketch_erase: true } });
  assert.deepEqual(await lists(SKETCH), switched);

  const answer = await switchTo(sketchbook, false);
  assert.equal(answer.reloaded, 1, "the chat that has its pi is loaded again");
  assert.deepEqual(await lists(SKETCH), everywhere({ other: {} }));
  // The chat that had them has them no more: loaded again without the half, it reports none.
  assert.deepEqual((await reported()).filter((t) => SKETCH.includes(t.name)), []);
  // Nothing is written in their name: the default and the project's switches stay, and so do they after the project's
  // list is answered by a page that did not show them.
  assert.ok((await json("/api/tools")).off.includes("sketch_draw"));
  await json("/api/projects/studio/tools", "PUT", { off: projectOff.filter((name) => !name.startsWith("sketch_")) });
  assert.ok(db.projectTools("studio").off.includes("sketch_erase"));
  assert.ok(db.projectTools("studio").on.includes("sketch_draw"));

  await switchTo(sketchbook, true);
  assert.deepEqual(await lists(SKETCH), switched);
  assert.deepEqual((await reported()).filter((t) => SKETCH.includes(t.name)).map((t) => [t.name, t.enabled]), [["sketch_draw", false], ["sketch_erase", true]]);
});

test("switched on, and crashed or failing to start, a server half's tools are listed as they were remembered", async () => {
  await json("/api/x/test-sketchbook/crash", "POST", {});
  await until(async () => (await standing("test-sketchbook"))?.crash !== undefined, "the half has crashed");
  assert.equal((await standing("test-sketchbook")).server, undefined, "it is not running");
  assert.deepEqual((await lists(SKETCH)).settings, { sketch_draw: false, sketch_erase: true });

  // Written anew to fail as it starts, and installed again by its folder, as a package being written there is loaded again.
  standIn("test-sketchbook", "sketch", { start: `throw new Error("cannot start today");` });
  await install(sketchbook);
  assert.match((await standing("test-sketchbook")).serverError, /cannot start today/);
  assert.deepEqual((await lists(SKETCH)).settings, { sketch_draw: false, sketch_erase: true });
  standIn("test-sketchbook", "sketch");
  await install(sketchbook);
  assert.ok((await standing("test-sketchbook")).server, "it runs again");
});

test("uninstalled, a server half's tools are not listed; installed again, they are, with the default somebody set", async () => {
  await uninstall(sketchbook);
  assert.deepEqual(await lists(SKETCH), everywhere({ other: {} }));
  assert.ok((await json("/api/tools")).off.includes("sketch_draw"));
  await install(sketchbook);
  assert.deepEqual((await lists(SKETCH)).settings, { sketch_draw: false, sketch_erase: true });
});

test("the portal's own inline tools are no package's: listed while a server half is switched off", async () => {
  const own = (await reported()).filter((t) => t.inline && !SKETCH.includes(t.name)).map((t) => t.name);
  for (const name of ["ask_question", "codemode"]) assert.ok(own.includes(name), `the chat reported the portal's own ${name}: ${own.join(", ")}`);
  await switchTo(sketchbook, false);
  const shown = (await json("/api/tools")).tools.filter((t) => t.inline).map((t) => t.name);
  for (const name of own) assert.ok(shown.includes(name), `${name} is listed`);
  assert.ok(!shown.some((name) => SKETCH.includes(name)));
  await switchTo(sketchbook, true);
});

test("a server half in a process of its own is listed the same way: while it is switched on", async () => {
  const tracer = standIn("test-tracer", "trace", { isolated: true });
  const TRACE = ["trace_draw", "trace_erase"];
  await install(tracer);
  assert.deepEqual((await reported()).filter((t) => TRACE.includes(t.name)).map((t) => [t.name, t.source, t.inline]), [["trace_draw", "test-tracer", true], ["trace_erase", "test-tracer", true]]);
  assert.deepEqual(await lists(TRACE), everywhere({ other: { trace_draw: true, trace_erase: true } }));
  await switchTo(tracer, false);
  assert.deepEqual(await lists(TRACE), everywhere({ other: {} }));
  await switchTo(tracer, true);
  assert.deepEqual(await lists(TRACE), everywhere({ other: { trace_draw: true, trace_erase: true } }));
  await uninstall(tracer);
  assert.deepEqual(await lists(TRACE), everywhere({ other: {} }));
});
