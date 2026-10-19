import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratch } from "./server-harness.mjs";
import { IN_PLACE, IN_PROJECTS, LOADED_IN_FOLDERS, allowed, conversation, folder, folders, guardAs, loadedAt, loadedPlaces, nova, refused, root, writtenIn } from "./loaded-from-folders-harness.mjs";

// What pi, the MCP adapter, the heartbeat and the portal load out of a folder is said once, in
// pi/loaded-from-folders.ts (see loaded-from-folders-harness.mjs for how the tests walk it). The walk of the links is
// in loaded-from-folders-links.test.mjs and loaded-from-folders-capitals.test.mjs.
test("every name on the list is held, in every folder a conversation or a look runs in, whoever else is speaking there", () => {
  assert.ok(LOADED_IN_FOLDERS.length >= 10);
  for (const role of ["colleague", "guest"]) {
    const as = guardAs(role, conversation);
    for (const entry of LOADED_IN_FOLDERS) {
      for (const [label, dir] of Object.entries(folders)) {
        for (const tool of ["write", "edit"]) {
          const where = writtenIn(dir, entry);
          assert.equal(refused(as, tool, where), true, `${role} ${tool} ${entry.name} in ${label}: ${where}`);
        }
      }
      // Told apart from case, and by a path that goes round.
      assert.equal(refused(as, "write", writtenIn(conversation, { ...entry, name: entry.name.toUpperCase() })), true, `${role} ${entry.name} in capitals`);
      assert.equal(refused(as, "write", `${conversation}/notes/../${path.relative(conversation, writtenIn(conversation, entry))}`), true, `${role} ${entry.name} by a path that goes round`);
    }
    // What is read from above the folder counts wherever it is; the rest only where a conversation runs.
    for (const entry of LOADED_IN_FOLDERS.filter((e) => e.above || e.folder)) assert.equal(refused(as, "write", writtenIn("/somewhere/else", entry)), true, `${role} ${entry.name} elsewhere`);
    // Without a folder to hold it to, by name in every folder.
    for (const entry of LOADED_IN_FOLDERS) assert.equal(refused(guardAs(role), "write", writtenIn("/anywhere", entry)), true, `${role} ${entry.name} with no folder`);
  }
  // The primary user's agent writes them. A heartbeat is held to them as well: it looks around on its own, on what it reads.
  for (const entry of LOADED_IN_FOLDERS) {
    assert.equal(allowed(guardAs("primary", conversation), "write", writtenIn(conversation, entry)), true, `primary ${entry.name}`);
    assert.equal(refused(guardAs("heartbeat", conversation), "write", writtenIn(conversation, entry)), true, `heartbeat ${entry.name}`);
  }
});

test("what the rule is for goes through: notes, the shared file, and names that only look like these", () => {
  for (const role of ["colleague", "guest"]) {
    const as = guardAs(role, conversation);
    for (const [label, dir] of Object.entries(folders)) {
      for (const name of ["notes/new.md", "TEAM.md", "mcp.json", ".mcp.json.bak", "agent-notes.md", ".vscode/settings.json", "docs/agents-guide.md", "docs/opencode-notes.json", ".pitch/x.ts", ".agent-names"]) {
        assert.equal(allowed(as, "write", path.join(dir, name)), true, `${role} ${name} in ${label}`);
      }
    }
    // A note called like one of the agent's files, in a folder no conversation runs in.
    assert.equal(allowed(as, "write", path.join(nova, "notes", "memory.md")), true);
    assert.equal(allowed(as, "write", path.join(nova, "notes", ".mcp.json")), true);
  }
});

test("a link inside a folder that is loaded whole leads to a place that is loaded as well, link in link, wherever that folder is", () => {
  let n = 0;
  const made = [];
  for (const [label, dir] of Object.entries(folders)) {
    for (const entry of LOADED_IN_FOLDERS.filter((e) => e.folder)) {
      // A project that shares its skills between tools: `.agents/skills` is a link to a folder beside it.
      const behind = path.join(folder, "shared", `${n++}`, "skills");
      const lib = path.join(folder, "lib", `${n++}`, "deploy");
      mkdirSync(path.join(behind, "release"), { recursive: true });
      mkdirSync(lib, { recursive: true });
      const inside = path.join(dir, entry.name);
      rmSync(inside, { force: true, recursive: true }); // a link there from the test before, which leads nowhere yet
      mkdirSync(inside, { recursive: true });
      symlinkSync(path.relative(inside, behind), path.join(inside, "skills"));
      symlinkSync(lib, path.join(behind, "deploy"));
      made.push({ label: `${entry.name} in ${label}`, written: path.join(behind, "release", "SKILL.md"), nested: path.join(lib, "SKILL.md"), beside: path.join(path.dirname(behind), "notes.md") });
    }
  }
  for (const role of ["colleague", "guest"]) {
    for (const { label, written, nested, beside } of made) {
      const as = guardAs(role, conversation);
      assert.equal(refused(as, "write", written), true, `${role}: ${label}: ${written}`);
      assert.equal(refused(as, "write", nested), true, `${role}: ${label}: a link in what the link leads to, ${nested}`);
      assert.equal(allowed(as, "write", beside), true, `${role}: ${label}: beside it`);
    }
  }
  // The same for the places held whole: a skill under development, installed in pi's agent folder as a link.
  for (const place of [process.env.PI_CODING_AGENT_DIR, process.env.CHANNELS_DIR]) {
    const project = path.join(folder, "lib", `${n++}`);
    mkdirSync(path.join(project, "foo"), { recursive: true });
    mkdirSync(path.join(place, "skills"), { recursive: true });
    symlinkSync(path.join(project, "foo"), path.join(place, "skills", "foo"));
    for (const role of ["colleague", "guest"]) {
      assert.equal(refused(guardAs(role, conversation), "write", path.join(project, "foo", "SKILL.md")), true, `${role}: a link inside ${place}`);
      assert.equal(allowed(guardAs(role, conversation), "write", path.join(project, "notes.md")), true, `${role}: beside it`);
    }
  }
});

/** `count` empty folders in `dir`: what a package fetched from git, or a folder of runtime files, comes to. */
const manyFolders = (dir, count) => {
  for (let i = 0; i < count; i++) mkdirSync(path.join(dir, `d${i}`), { recursive: true });
};

test("a big package in one place does not hide a link beside it, in that place or in another", () => {
  let n = 0;
  const behind = () => path.join(folder, "starve", `${n++}`);
  const made = [];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    // An extension under development, linked into pi's agent folder, and a git package that pi fetched there, as a working tree. It sorts after.
    const ext = behind();
    mkdirSync(ext, { recursive: true });
    mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    symlinkSync(ext, path.join(agentDir, "extensions", "my-ext"));
    manyFolders(path.join(agentDir, "git", "example.test", "big-repo"), IN_PLACE + 100);
    made.push({ label: "a link in pi's agent folder, beside a big git package", written: path.join(ext, "index.ts"), beside: path.join(path.dirname(ext), "notes.md") });

    // The same in a project, and in a later one: each `.pi` has an allowance of its own.
    const a = path.join(root, "starve-a");
    mkdirSync(path.join(a, "tools", "ext"), { recursive: true });
    mkdirSync(path.join(a, ".pi", "extensions"), { recursive: true });
    symlinkSync("../../tools/ext", path.join(a, ".pi", "extensions", "ext"));
    manyFolders(path.join(a, ".pi", "git", "example.test", "big-repo"), IN_PLACE + 100);
    made.push({ label: "a link in a project's .pi, beside a big git package", written: path.join(a, "tools", "ext", "x.ts"), beside: path.join(a, "tools", "notes.md") });
    const b = path.join(root, "starve-b");
    mkdirSync(path.join(b, ".claude", "skills"), { recursive: true });
    mkdirSync(path.join(b, ".agents"), { recursive: true });
    symlinkSync("../.claude/skills", path.join(b, ".agents", "skills"));
    made.push({ label: "a link in the .agents of a later project", written: path.join(b, ".claude", "skills", "release", "SKILL.md"), beside: path.join(b, ".claude", "notes.md") });

    for (const role of ["colleague", "guest"]) {
      for (const { label, written, beside } of made) {
        assert.equal(refused(guardAs(role, conversation), "write", written), true, `${role}: ${label}: ${written}`);
        assert.equal(allowed(guardAs(role, conversation), "write", beside), true, `${role}: ${label}: beside it`);
      }
    }
  } finally {
    rmSync(path.join(agentDir, "git"), { recursive: true, force: true });
    rmSync(path.join(agentDir, "extensions", "my-ext"), { force: true });
    rmSync(path.join(root, "starve-a"), { recursive: true, force: true });
    rmSync(path.join(root, "starve-b"), { recursive: true, force: true });
  }
});

test("a write by the name of a link at a loaded name is refused where the walk gave up before it reached the link", () => {
  // A project with a big folder of runtime files (a venv, a target) in front of the package that has the link: the walk over the projects is spent there.
  const app = path.join(root, "spent");
  try {
    manyFolders(path.join(app, ".venv"), IN_PROJECTS + 100);
    mkdirSync(path.join(app, "packages", "api", "web"), { recursive: true });
    writeFileSync(path.join(app, "notes.md"), "notes");
    symlinkSync("../../../notes.md", path.join(app, "packages", "api", "web", "AGENTS.md"));
    for (const role of ["colleague", "guest"]) {
      const as = guardAs(role, conversation);
      // The premise: the link was not found, so what it leads to is a note as far as the walk can tell.
      assert.equal(allowed(as, "write", path.join(app, "notes.md")), true, `${role}: the walk reached the link, so this does not test the name`);
      // The name is held all the same: what is written there is loaded as the instructions of every conversation in that folder.
      assert.equal(refused(as, "write", path.join(app, "packages", "api", "web", "AGENTS.md")), true, `${role}: written by the link's name`);
      assert.equal(refused(as, "edit", path.join(app, "packages", "api", "web", "AGENTS.md")), true, `${role}: edited by the link's name`);
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("a link in ~/.agents, or ~/.agents as a link, is followed: pi and the adapter load it for every conversation", () => {
  const was = process.env.HOME;
  try {
    for (const layout of ["skills", "mcp.json", "the folder itself"]) {
      const home = scratch("loaded-home-");
      process.env.HOME = home;
      assert.ok(loadedPlaces().some((place) => place.path === path.join(home, ".agents") && place.by === "pi"), "the folder is a place");
      const behind = path.join(folder, "agents-home", layout.replace(/\W/g, "-"));
      mkdirSync(behind, { recursive: true });
      let written;
      if (layout === "the folder itself") {
        symlinkSync(behind, path.join(home, ".agents"));
        written = path.join(behind, "skills", "x", "SKILL.md");
      } else {
        mkdirSync(path.join(home, ".agents"));
        symlinkSync(layout === "skills" ? behind : path.join(behind, "mcp.json"), path.join(home, ".agents", layout));
        written = layout === "skills" ? path.join(behind, "release", "SKILL.md") : path.join(behind, "mcp.json");
      }
      for (const role of ["colleague", "guest"]) {
        assert.equal(refused(guardAs(role, conversation), "write", written), true, `${role}: ${layout}: ${written}`);
        assert.equal(allowed(guardAs(role, conversation), "write", path.join(path.dirname(behind), "notes.md")), true, `${role}: ${layout}: beside it`);
      }
    }
  } finally {
    process.env.HOME = was;
  }
});

test("pi reads the instructions from every folder above the workspace root, so a link at a name there is followed", () => {
  const above = path.dirname(root);
  const behind = path.join(folder, "above", "ai.md");
  mkdirSync(path.dirname(behind), { recursive: true });
  symlinkSync(behind, path.join(above, "CLAUDE.md"));
  try {
    for (const role of ["colleague", "guest"]) {
      assert.equal(refused(guardAs(role, conversation), "write", behind), true, `${role}: what a link above the root leads to`);
      assert.equal(allowed(guardAs(role, conversation), "write", path.join(path.dirname(behind), "notes.md")), true, `${role}: beside it`);
    }
  } finally {
    rmSync(path.join(above, "CLAUDE.md"), { force: true });
  }
});

test("the portal's own folder is read by the MCP adapter, and a link there is followed", () => {
  const names = [".mcp.json", ".vscode/mcp.json"];
  for (const name of names) assert.ok(loadedPlaces().some((place) => place.path === path.join(process.cwd(), ...name.split("/")) && place.by === "mcp"), `${name} in the folder the portal runs in is a place`);
  const was = process.cwd();
  const where = scratch("loaded-cwd-");
  process.chdir(where);
  try {
    const behind = path.join(folder, "behind-cwd", "tools.json");
    symlinkSync(behind, path.join(where, ".mcp.json"));
    for (const role of ["colleague", "guest"]) {
      assert.equal(refused(guardAs(role, conversation), "write", path.join(os.tmpdir(), path.basename(where), ".mcp.json")), true, `${role}: the file`);
      assert.equal(refused(guardAs(role, conversation), "write", behind), true, `${role}: what a link there leads to`);
      assert.equal(allowed(guardAs(role, conversation), "write", path.join(path.dirname(behind), "other.md")), true, `${role}: beside it`);
    }
  } finally {
    process.chdir(was);
  }
});

test("the folders and files the portal hands pi or loads itself are held where they are, by whatever path they are reached", () => {
  const places = loadedPlaces();
  assert.ok(places.length >= 8, "pi's agent folder, what ships with the portal, the channel packages, the MCP adapter's configs in the home");
  for (const role of ["colleague", "guest"]) {
    const as = guardAs(role, conversation);
    for (const place of places) {
      assert.equal(refused(as, "write", path.join(place.path, "x.ts")), true, `${role}: below ${place.path}`);
      assert.equal(refused(as, "write", place.path), true, `${role}: ${place.path}`);
    }
  }
  const named = (as) => places.filter((place) => place.as === as).length;
  assert.ok(named("code") >= 1 && named("tools") >= 1 && named("instructions") >= 2, "each kind of place is there");
  // The channel packages are code the portal runs: a write into the folder they are installed in.
  const installed = path.join(process.env.CHANNELS_DIR, "node_modules", "pithagoras-channel-x", "index.js");
  assert.equal(refused(guardAs("colleague", conversation), "write", installed), true);
});

test("a place the environment points at through a link is held by the path it really has, as it is by the path it was given", () => {
  for (const variable of ["PI_CODING_AGENT_DIR", "CHANNELS_DIR"]) {
    const real = path.join(folder, `real-${variable}`);
    const via = path.join(folder, `via-${variable}`);
    mkdirSync(real, { recursive: true });
    symlinkSync(real, via);
    const was = process.env[variable];
    process.env[variable] = via;
    try {
      for (const role of ["colleague", "guest"]) {
        for (const where of [path.join(real, "extensions", "evil.ts"), path.join(via, "extensions", "evil.ts"), real]) {
          assert.equal(refused(guardAs(role, conversation), "write", where), true, `${role}: ${variable}, ${where}`);
        }
        assert.equal(allowed(guardAs(role, conversation), "write", path.join(folder, `real-${variable}-notes.md`)), true, `${role}: a file beside it`);
      }
    } finally {
      process.env[variable] = was;
    }
  }
});

test("loadedAt answers by the name and for the folder it would be read from", () => {
  assert.equal(loadedAt("/w/site/.mcp.json")?.by, "mcp");
  assert.equal(loadedAt("/w/site/.VSCODE/MCP.json")?.by, "mcp");
  assert.equal(loadedAt("/w/site/AGENTS.md")?.by, "pi");
  assert.equal(loadedAt("/w/site/.pi/x/y")?.by, "pi");
  assert.equal(loadedAt("/w/site/notes.md"), undefined);
  assert.equal(loadedAt("/w/site/mcp.json"), undefined, "a name that is only part of one");
  assert.equal(loadedAt("/w/site/SOUL.md", (dir) => dir === "/w/site")?.by, "portal");
  assert.equal(loadedAt("/w/site/notes/SOUL.md", (dir) => dir === "/w/site"), undefined, "not read from a folder nothing runs in");
  assert.equal(loadedAt("/w/site/notes/AGENTS.md", () => false)?.by, "pi", "pi reads it from above as well");
});

// --- the list against what pi loads, and against the page that tells the primary user ---

const pi = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piSource = (file) => readFileSync(path.join(pi, file), "utf8");

test("what pi's resource loader reads by name is on the list, and what is on the list as pi's is read", async () => {
  const { CONFIG_DIR_NAME, loadProjectContextFiles } = await import("@earendil-works/pi-coding-agent");
  assert.ok(LOADED_IN_FOLDERS.some((e) => e.folder && e.name.toLowerCase() === CONFIG_DIR_NAME.toLowerCase()), `pi's folder for its own config is ${CONFIG_DIR_NAME}`);

  // The names pi reads a folder's instructions from, as its loader spells them.
  const candidates = /const candidates = \[([^\]]+)\]/.exec(piSource("core/resource-loader.js"))?.[1];
  assert.ok(candidates, "pi's loader still lists the names it reads (core/resource-loader.js): add what it reads now to loaded-from-folders.ts and teach this test");
  const names = [...candidates.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 2);
  for (const name of names) {
    assert.ok(loadedAt(path.join("/w/site", name)), `pi reads ${name}, so it is on the list`);
  }
  // And what is on the list for pi is read: written into a folder, pi's own loader finds it.
  for (const entry of LOADED_IN_FOLDERS.filter((e) => e.by === "pi" && !e.folder)) {
    const dir = scratch("loaded-pi-");
    writeFileSync(path.join(dir, entry.name), "instructions");
    const found = loadProjectContextFiles({ cwd: dir, agentDir: scratch("loaded-pi-agent-") }).map((f) => path.basename(f.path));
    assert.ok(found.includes(entry.name), `pi reads ${entry.name} from the folder it runs in`);
  }

  // What pi treats as its project config, each a name inside its folder.
  const trusted = /TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = \[([^\]]+)\]/.exec(piSource("core/trust-manager.js"))?.[1];
  assert.ok(trusted, "pi still lists what a project's config folder holds (core/trust-manager.js)");
  for (const [, name] of trusted.matchAll(/"([^"]+)"/g)) {
    assert.ok(loadedAt(path.join("/w/site", CONFIG_DIR_NAME, name, "x")), `pi reads ${CONFIG_DIR_NAME}/${name}`);
  }
  assert.match(piSource("core/package-manager.js"), /join\(dir, "\.agents", "skills"\)/, "pi still reads skills from .agents, which is on the list as a folder");
});

test("the adapter's names on the list are the ones of the version the portal installs", async () => {
  // The adapter is not a dependency of the portal, so its source is not here to read: what ties the list to it is
  // the version it was compared with, which the portal pins. When the pin moves, whoever moves it compares the adapter's
  // config.ts with the list first, and then says so here.
  const { ADAPTER_SPEC } = await import("../dist/api/mcp.js");
  const COMPARED = "npm:pi-mcp-adapter@2.18.0";
  assert.equal(ADAPTER_SPEC, COMPARED, "the adapter the portal installs changed: compare its IMPORT_PATHS and PROJECT_CONFIG_NAME (config.ts) with LOADED_IN_FOLDERS and loadedPlaces in loaded-from-folders.ts, add what is new, then set the version compared here");
  // What 2.18.0 reads, as its config.ts has it: the names in a folder, and the files in the home folder.
  for (const name of [".mcp.json", ".vscode/mcp.json", "opencode.json", ".pi/mcp.json", ".agents/mcp.json"]) assert.ok(loadedAt(path.join("/w/site", name)), `${name} is on the list`);
  const home = os.homedir();
  for (const file of [".config/mcp/mcp.json", ".cursor/mcp.json", ".claude/mcp.json", ".claude.json", ".claude/claude_desktop_config.json", "Library/Application Support/Claude/claude_desktop_config.json", ".codex/config.toml", ".codex/config.json", ".config/opencode/opencode.json", ".windsurf/mcp.json", ".agents/mcp.json"]) {
    assert.ok(loadedPlaces().some((place) => place.path === path.join(home, file)) || loadedAt(path.join(home, file)), `~/${file} is held`);
  }
});

test("the page on roles names everything on the list", () => {
  const docs = (file) => readFileSync(fileURLToPath(new URL(`../../../docs/${file}`, import.meta.url)), "utf8").replace(/\s+/g, " ");
  const roles = docs("people/roles.md");
  for (const entry of LOADED_IN_FOLDERS) assert.ok(roles.includes(`\`${entry.name}\``), `docs/people/roles.md names ${entry.name}`);
  for (const word of ["pi's own agent folder", "the folders that come with the portal", "channel packages", "tool servers"]) assert.ok(roles.includes(word), `docs/people/roles.md says ${word}`);
});
