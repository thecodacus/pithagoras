import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { inProcessHome, scratch } from "./server-harness.mjs";

// What pi, the MCP adapter, the heartbeat and the portal load out of a folder is said once, in
// pi/loaded-from-folders.ts. What a colleague or a guest may write is held to that list, and a
// test that walks it fails for a name that is on it and not held, wherever a conversation runs.

inProcessHome("loaded-folders-");
const { guardExtension } = await import("../dist/pi/guard.js");
export const { LOADED_IN_FOLDERS, loadedAt, loadedPlaces } = await import("../dist/pi/loaded-from-folders.js");
const { addToolRule, deleteToolRule } = await import("../dist/db.js");
export const { agentsRoot, createAgent, deleteAgent } = await import("../dist/agents.js");
export const { IN_PLACE, IN_PROJECTS } = await import("../dist/pi/loaded-links.js");

mock.method(console, "warn", () => {});

export const root = process.env.WORKSPACE_ROOT;
export const folder = scratch("loaded-folders-");
export const guardAs = (role, workspace) => {
  const h = {};
  guardExtension("t", () => ({ role, key: "priya" }), "s", () => new Set(), () => ({ allowed: false, allowlist: [] }), workspace)({ on: (k, f) => (h[k] = f) });
  return h;
};
/** Whether a write by this guard is refused as one that reaches what is loaded; a write the rules allow is undefined. */
export const outcome = (h, tool, where) => {
  const result = h.tool_call({ toolName: tool, input: { path: where, content: "x", edits: [] } });
  if (result === undefined) return "allowed";
  return result.block === true && /^Refused: it writes to /.test(result.reason) ? "refused" : `blocked: ${result.reason}`;
};
export const refused = (h, tool, where) => outcome(h, tool, where) === "refused";
export const allowed = (h, tool, where) => outcome(h, tool, where) === "allowed";

/** Where a write to this entry is aimed in a folder: the file itself, or a file somewhere inside the folder. */
export const writtenIn = (dir, entry) => (entry.folder ? path.join(dir, entry.name, "deep", "x.ts") : path.join(dir, ...entry.name.split("/")));

export const rules = ["write", "edit"].map((tool) => {
  const id = `rule-loaded-walk-${tool}`;
  addToolRule({ id, role: "all", tool, pattern: "*", note: "", person_key: null });
  return id;
});
test.after(() => rules.forEach(deleteToolRule));

// Every kind of folder a conversation of the primary user, or the next one of an agent, may read from.
mkdirSync(path.join(root, "site", "sub"), { recursive: true });
mkdirSync(path.join(root, "mono", "packages", "api"), { recursive: true });
export const nova = createAgent({ name: "Nova" }).home;
const gone = createAgent({ name: "Gone" });
deleteAgent(gone.id, { deleteFolder: false });
export const kept = gone.home;
export const notMade = path.join(agentsRoot(), "finance");
export const conversation = path.join(folder, "conversation");
mkdirSync(conversation, { recursive: true });
export const folders = {
  "the folder of the conversation": conversation,
  "another agent's home": nova,
  "the folder kept from an agent that is gone": kept,
  "the folder of an agent that is not made yet": notMade,
  "the top of a project": path.join(root, "site"),
  "a folder in a project": path.join(root, "site", "sub"),
  "a folder deep in a project": path.join(root, "mono", "packages", "api"),
};

/**
 * A link at a name on the list is followed to what it leads to, for a file that is not there yet, in the folders a
 * conversation or a look runs in. Walked once for each spelling of the names it is given, in a file of its own for each:
 * the walk is the longest of the file's tests by far, and the runner gives a file as long as it gives any.
 */
export function linksAreFollowed(spellings) {
  let n = 0;
  const places = {
    "the folder of the conversation": () => path.join(folder, `link-${n++}`),
    "another agent's home": () => nova,
    "the folder kept from an agent that is gone": () => kept,
    "the folder of an agent that is not made yet": () => path.join(agentsRoot(), `later-${n++}`),
    "the top of a project": () => path.join(root, `project-${n++}`),
    "a folder deep in a project": () => path.join(root, `deep-${n++}`, "packages", "api"),
    "the workspace root": () => root,
  };
  // The name is a link to something that is not there yet; what is written there is loaded under the name.
  const linked = [];
  for (const [spelling, spell] of spellings) {
    for (const [label, pick] of Object.entries(places)) {
      for (const entry of LOADED_IN_FOLDERS) {
        const dir = pick();
        const target = path.join(folder, "behind", `${n++}`, entry.folder ? "dir" : "file");
        const at = path.join(dir, ...spell(entry.name).split("/"));
        mkdirSync(path.dirname(at), { recursive: true });
        rmSync(at, { force: true }); // a file an agent's folder has already, such as the name it was made for
        symlinkSync(target, at);
        linked.push({ label: `${label}, ${spelling}`, entry, runsIn: label === "the folder of the conversation" ? dir : conversation, written: entry.folder ? path.join(target, "extensions", "x.ts") : target, beside: path.join(path.dirname(target), "other.md") });
      }
    }
  }
  for (const role of ["colleague", "guest"]) {
    for (const { label, entry, runsIn, written, beside } of linked) {
      const as = guardAs(role, runsIn);
      assert.equal(refused(as, "write", written), true, `${role}: ${entry.name} as a link in ${label}, written as ${written}`);
      assert.equal(refused(as, "edit", written), true, `${role}: ${entry.name} as a link in ${label}, edited as ${written}`);
      // And a file beside it, which no link leads to, is a note.
      assert.equal(allowed(as, "write", beside), true, `${role}: beside it in ${label}`);
    }
  }
}
