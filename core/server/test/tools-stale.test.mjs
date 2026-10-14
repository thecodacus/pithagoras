import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-stale-");
const settings = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
const listPackages = (packages) => writeFileSync(settings, JSON.stringify({ packages }));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "jira-mcp" } } }));
const OFF = (source) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });

const { createSession, forgetPackageTools, knownTools, rememberTools, shownTools } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

const TODO = "npm:@juicesharp/rpiv-todo";
const names = () => knownTools().map((t) => t.name).sort();

test("the tools of a package that is switched off are not listed, and come back with it", async () => {
  listPackages([TODO]);
  rememberTools([
    { name: "todo", source: "@juicesharp/rpiv-todo", package: TODO },
    { name: "bash", source: "built in", package: null },
  ]);
  assert.deepEqual(shownTools().map((t) => t.name), ["bash", "todo"]);

  listPackages([OFF(TODO)]);
  assert.deepEqual(shownTools().map((t) => t.name), ["bash"]);
  // An idle chat is offered what is shown, not the whole catalogue.
  createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });
  assert.deepEqual((await sessions.getTools("idle")).tools.map((t) => t.name), ["bash"]);
  // Remembered all the same, for when the package is switched on again.
  assert.deepEqual(names(), ["bash", "todo"]);

  listPackages([TODO]);
  assert.deepEqual((await sessions.getTools("idle")).tools.map((t) => t.name), ["bash", "todo"]);
});

test("a package that is gone from the settings takes its tools out of the list", () => {
  listPackages([]);
  assert.deepEqual(shownTools().map((t) => t.name), ["bash"]);
});

test("a session that still has an uninstalled package loaded does not bring its tools back", () => {
  listPackages(["npm:pi-other"]);
  rememberTools([
    { name: "todo_late", source: "@juicesharp/rpiv-todo", package: TODO },
    { name: "other", source: "pi-other", package: "npm:pi-other" },
  ]);
  assert.deepEqual(names(), ["bash", "other", "todo"]);
});

test("uninstalling forgets the tools, whichever version they were recorded under, and ones from before", () => {
  listPackages([`${TODO}@0.5.0`, "npm:pi-other"]);
  rememberTools([
    { name: "todo_old", source: "@juicesharp/rpiv-todo" },
    // A folder of the user's filed under the same label: recorded as no package's, so not the package's.
    { name: "todo_mine", source: "@juicesharp/rpiv-todo", package: null },
  ]);
  // Asked for once pi has taken it out of the settings.
  listPackages(["npm:pi-other"]);
  forgetPackageTools(`${TODO}@0.5.0`);
  assert.deepEqual(names(), ["bash", "other", "todo_mine"]);
});

test("uninstalling forgets whatever is no longer listed, however the request wrote it", () => {
  listPackages(["../../ext/foo", "npm:pi-other"]);
  rememberTools([{ name: "foo_tool", source: "foo", package: "../../ext/foo" }]);
  listPackages(["npm:pi-other"]);
  forgetPackageTools("/home/u/ext/foo");
  assert.deepEqual(names(), ["bash", "other", "todo_mine"]);
});

test("an MCP server's tools are kept when the adapter is uninstalled", () => {
  listPackages(["npm:pi-mcp-adapter", "npm:pi-other"]);
  rememberTools([{ name: "jira_search", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter" }]);
  listPackages(["npm:pi-other"]);
  forgetPackageTools("npm:pi-mcp-adapter");
  assert.deepEqual(names(), ["bash", "jira_search", "other", "todo_mine"]);
  // Hidden all the same, since nothing registers them while the adapter is gone.
  assert.equal(shownTools().some((t) => t.name === "jira_search"), false);
});

test("a project bringing the user's package in its own settings does not take its tools from it", () => {
  listPackages(["npm:pi-other"]);
  rememberTools([{ name: "other", source: "pi-other", package: null }]);
  assert.equal(knownTools().find((t) => t.name === "other").package, "npm:pi-other");
  listPackages([OFF("npm:pi-other")]);
  assert.equal(shownTools().some((t) => t.name === "other"), false);
});

test("uninstalling a folder forgets the entries from before by the folder's name", () => {
  rememberTools([{ name: "subagent", source: "subagent" }]);
  forgetPackageTools("../../extensions/subagent");
  assert.equal(knownTools().some((t) => t.name === "subagent"), false);
});

test("an idle chat in a project that brings the package itself is offered its tools", async () => {
  const project = path.join(home, "proj");
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-other"] }));
  listPackages([OFF("npm:pi-other")]);
  createSession({ id: "in-project", title: "p", workspace: project, executor: "host" });
  assert.ok((await sessions.getTools("in-project")).tools.some((t) => t.name === "other"));
  assert.ok(!(await sessions.getTools("idle")).tools.some((t) => t.name === "other"));
});

test("what is shown carries no package", () => {
  listPackages(["npm:pi-other"]);
  assert.equal(shownTools().some((t) => "package" in t), false);
});
