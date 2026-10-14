import { test, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The Skills page's own routes: what it lists, and what delete and the switch
 * do to the folder of skills pi reads. In this process, with no server around
 * it, so that what loads an extension is only what these routes do.
 */
const home = inProcessHome("pithagoras-skills-api-");
const agent = process.env.PI_CODING_AGENT_DIR;
const skills = path.join(agent, "skills");
const marker = path.join(home, "extension-ran");

const skill = (name, description = "Use it when the tests say so") => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`;
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// pi loads direct .md files of the skills folder as skills too.
put(path.join(skills, "x.md"), skill("x"));
put(path.join(skills, "y", "SKILL.md"), skill("y"));
put(path.join(skills, "z", "SKILL.md"), skill("z"));
put(path.join(skills, "z", "notes.txt"), "notes of z");

// An extension that says so each time its factory is run, which loading it does.
put(path.join(agent, "extensions", "probe.ts"), `
import { appendFileSync } from "node:fs";
export default function () {
  appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
}
`);

// A package that ships a skill, as `pi install` leaves one listed in settings.json.
const pkg = path.join(home, "pi-example");
put(path.join(pkg, "package.json"), JSON.stringify({ name: "pi-example", version: "1.0.0", pi: { skills: ["skills"] } }));
put(path.join(pkg, "skills", "shipped", "SKILL.md"), skill("shipped"));
put(path.join(agent, "settings.json"), JSON.stringify({ packages: [pkg] }));

const { skillsRouter } = await import("../dist/api/skills.js");
const app = express();
app.use(express.json());
app.use("/api", skillsRouter());
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (url) => (await fetch(base + url)).json();
const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("listing the skills does not load the extensions, and still has the skills of packages", async () => {
  const listed = await get("/api/skills");
  const byName = Object.fromEntries(listed.skills.map((s) => [s.name, s]));
  assert.equal(byName.y.editable, true);
  assert.equal(byName.shipped.editable, false, "a package's skill is listed, and is the package's");
  assert.equal(existsSync(marker), false, "an extension's factory ran in the portal just to list skills");
});

test("a skill that is a single file in the skills folder is listed as one to change", async () => {
  const listed = await get("/api/skills");
  const x = listed.skills.find((s) => s.name === "x");
  assert.equal(x.editable, true);
  assert.equal(x.path, path.join(skills, "x.md"));
});

test("it cannot be switched off like a folder's skill, and says so", async () => {
  const res = await send("/api/skills/x/enabled", "POST", { enabled: false });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /single file/);
  assert.equal(existsSync(path.join(skills, "x.md")), true);
});

test("deleting a single-file skill deletes that file, and not the skills beside it", async () => {
  const res = await send("/api/skills/x", "DELETE");
  assert.equal(res.status, 200);
  assert.equal(existsSync(path.join(skills, "x.md")), false);
  assert.equal(existsSync(path.join(skills, "y", "SKILL.md")), true, "the other skills are still there");
  assert.equal(existsSync(path.join(skills, "z", "SKILL.md")), true);
  assert.equal(existsSync(skills), true);
  const names = (await get("/api/skills")).skills.map((s) => s.name);
  assert.equal(names.includes("x"), false);
  assert.ok(["y", "z", "shipped"].every((n) => names.includes(n)));
});

test("deleting a skill in a folder of its own still deletes the folder with what is in it", async () => {
  const res = await send("/api/skills/z", "DELETE");
  assert.equal(res.status, 200);
  assert.equal(existsSync(path.join(skills, "z")), false);
  assert.equal(existsSync(path.join(skills, "y", "SKILL.md")), true);
});

test("a skill of a package is not deleted from here", async () => {
  const res = await send("/api/skills/shipped", "DELETE");
  assert.equal(res.status, 400);
  assert.equal(existsSync(path.join(pkg, "skills", "shipped", "SKILL.md")), true);
});
