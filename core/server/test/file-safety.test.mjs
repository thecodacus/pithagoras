import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { inProcessHome } from "./server-harness.mjs";

const dist = (name) => pathToFileURL(new URL(`../dist/${name}`, import.meta.url).pathname).href;
const home = inProcessHome("file-safety-");
const { writeFileAtomic } = await import("../dist/atomic-write.js");
const { writeMcpText, writeMcpFile } = await import("../dist/api/mcp.js");
const { agentFileStatus, isInitialised, readAgentFile, runWizard, writeAgentFile } = await import("../dist/agent-setup.js");
const { removeFolderLater, sweepRemoved } = await import("../dist/folder-removal.js");
const { FileError, removeEntry, renameEntry } = await import("../dist/workspace-files.js");
const P = await import("../dist/projects.js");

const fresh = (name) => { const dir = path.join(home, name); mkdirSync(dir, { recursive: true }); return dir; };
const left = (dir) => readdirSync(dir).filter((n) => n.endsWith(".tmp"));
const mode = (file) => statSync(file).mode & 0o777;

/**
 * Runs `code` as a program that may write no file larger than `bytes`: a full
 * disk, as far as one file goes. Writing past it fails with EFBIG. Where there
 * is no prlimit, the test is skipped.
 */
const hasPrlimit = spawnSync("prlimit", ["--version"]).status === 0;
function underLimit(bytes, code) {
  const run = spawnSync("prlimit", [`--fsize=${bytes}`, process.execPath, "--input-type=module", "-e", code], {
    env: process.env,
    encoding: "utf8",
  });
  return { out: run.stdout.trim(), err: run.stderr };
}
const FAILS = `try { RUN; console.log("wrote"); } catch (e) { console.log(e.code ?? e.message); }`;
const big = "x".repeat(200_000);

test("a file is put in place whole, with the mode asked for or the one it had", () => {
  const dir = fresh("atomic");
  const file = path.join(dir, "a.txt");
  writeFileAtomic(file, "one");
  assert.equal(readFileSync(file, "utf8"), "one");
  assert.equal(mode(file), 0o644);
  writeFileAtomic(file, "two", 0o600);
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.equal(mode(file), 0o600, "a file for secrets is not left readable");
  writeFileAtomic(file, "three");
  assert.equal(mode(file), 0o600, "it keeps the mode it had");
  assert.deepEqual(left(dir), []);
});

test("a link at the name is replaced, not written through", () => {
  const dir = fresh("atomic-link");
  const target = path.join(dir, "elsewhere");
  writeFileSync(target, "not yours");
  symlinkSync(target, path.join(dir, "linked"));
  writeFileAtomic(path.join(dir, "linked"), "new");
  assert.equal(readFileSync(target, "utf8"), "not yours");
  assert.equal(readFileSync(path.join(dir, "linked"), "utf8"), "new");
  const shared = path.join(dir, "shared");
  linkSync(target, shared);
  writeFileAtomic(shared, "again");
  assert.equal(readFileSync(target, "utf8"), "not yours", "a second name for a file is not written to either");
});

test("a write that fails halfway leaves the file as it was, and nothing behind", { skip: !hasPrlimit && "prlimit is not available" }, () => {
  const dir = fresh("atomic-full");
  const file = path.join(dir, "MEMORY.md");
  writeFileSync(file, "everything the agent has learned");
  const { out } = underLimit(100_000, `import { writeFileAtomic } from ${JSON.stringify(dist("atomic-write.js"))};
    ${FAILS.replace("RUN", `writeFileAtomic(${JSON.stringify(file)}, "y".repeat(500_000))`)}`);
  assert.equal(out, "EFBIG");
  assert.equal(readFileSync(file, "utf8"), "everything the agent has learned");
  assert.deepEqual(left(dir), []);
});

test("mcp.json is for its owner alone, and a failed save keeps the servers", { skip: !hasPrlimit && "prlimit is not available" }, () => {
  const file = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"mcpServers":{"keep":{"url":"http://x"}}}\n', { mode: 0o644 });
  writeMcpFile({ mcpServers: { keep: { url: "http://x" }, token: { bearerToken: "secret" } } });
  assert.equal(mode(file), 0o600);
  writeMcpText('{"mcpServers":{}}');
  assert.equal(mode(file), 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"mcpServers":{}}\n');

  writeMcpText('{"mcpServers":{"keep":{"url":"http://x"}}}');
  const before = readFileSync(file, "utf8");
  const { out } = underLimit(20_000, `import { writeMcpText } from ${JSON.stringify(dist("api/mcp.js"))};
    ${FAILS.replace("RUN", `writeMcpText(JSON.stringify({ mcpServers: { filler: { args: ["z".repeat(100_000)] } } }))`)}`);
  assert.equal(out, "EFBIG");
  assert.equal(readFileSync(file, "utf8"), before, "the servers are still there");
  assert.deepEqual(left(path.dirname(file)), []);
});

test("an agent file is saved whole: a save that fails leaves it as it was", { skip: !hasPrlimit && "prlimit is not available" }, () => {
  const dir = fresh("agent-fails");
  writeFileSync(path.join(dir, "MEMORY.md"), "the only copy\n");
  const { out } = underLimit(20_000, `import { writeAgentFile } from ${JSON.stringify(dist("agent-setup.js"))};
    ${FAILS.replace("RUN", `writeAgentFile("MEMORY.md", "w".repeat(100_000), ${JSON.stringify(dir)})`)}`);
  assert.equal(out, "failed", "refused as a save that did not happen, which is what the person is told");
  assert.equal(readFileSync(path.join(dir, "MEMORY.md"), "utf8"), "the only copy\n");
  assert.deepEqual(left(dir), []);
});

test("an agent file that changed since the page read it is not overwritten", () => {
  const dir = fresh("agent-conflict");
  writeFileSync(path.join(dir, "MEMORY.md"), "first\n");
  const seen = agentFileStatus(dir).files.find((f) => f.name === "MEMORY.md");
  assert.equal(seen.content, "first\n");
  assert.ok(seen.mtime > 0);
  writeAgentFile("MEMORY.md", "mine", dir, seen.mtime);
  assert.equal(readAgentFile("MEMORY.md", dir), "mine\n");
  // The agent writes three decisions after the page loaded.
  writeFileSync(path.join(dir, "MEMORY.md"), "mine\nthree decisions\n", { flush: true });
  const stale = new Date(seen.mtime - 5000);
  assert.throws(() => writeAgentFile("MEMORY.md", "a typo fixed", dir, stale.getTime()), (e) => e instanceof FileError && e.code === "conflict");
  assert.equal(readAgentFile("MEMORY.md", dir), "mine\nthree decisions\n");
  // Without an expected time the save goes through: what "save mine anyway" sends.
  writeAgentFile("MEMORY.md", "mine anyway", dir);
  assert.equal(readAgentFile("MEMORY.md", dir), "mine anyway\n");
});

test("a file the page saw as missing is made, unless the agent has made it since", () => {
  const dir = fresh("agent-watch");
  assert.equal(agentFileStatus(dir).files.find((f) => f.name === "WATCH.md").mtime, 0);
  writeAgentFile("WATCH.md", "watch the inbox", dir, 0);
  assert.equal(readAgentFile("WATCH.md", dir), "watch the inbox\n");
  assert.throws(() => writeAgentFile("WATCH.md", "again", dir, 0), (e) => e instanceof FileError && e.code === "conflict");
});

test("a link in place of an agent's file is neither read nor written through", () => {
  const dir = fresh("agent-link");
  const secret = path.join(home, "portal-secret.db");
  writeFileSync(secret, "the database");
  symlinkSync(secret, path.join(dir, "SOUL.md"));
  assert.equal(readAgentFile("SOUL.md", dir), "");
  assert.equal(agentFileStatus(dir).files.find((f) => f.name === "SOUL.md").content, "");
  assert.throws(() => writeAgentFile("SOUL.md", "overwritten", dir), (e) => e instanceof FileError && e.code === "invalid");
  assert.equal(readFileSync(secret, "utf8"), "the database");
  // One inside the folder is no better: writing "through" it would change what it leads to.
  writeFileSync(path.join(dir, "MEMORY.md"), "memory\n");
  symlinkSync(path.join(dir, "MEMORY.md"), path.join(dir, "WATCH.md"));
  assert.throws(() => writeAgentFile("WATCH.md", "overwritten", dir), (e) => e instanceof FileError && e.code === "invalid");
  assert.equal(readFileSync(path.join(dir, "MEMORY.md"), "utf8"), "memory\n");
  // The wizard leaves it too, and does not write through it.
  const answer = runWizard({ agentName: "Ada", userName: "Sam" }, dir);
  assert.deepEqual(answer.kept, ["SOUL.md", "MEMORY.md"]);
  assert.equal(readFileSync(secret, "utf8"), "the database");
});

test("a link that leads nowhere is something there: the wizard keeps it, and so the agent counts as set up", () => {
  // An agent under the container executor leaves SOUL.md as a link by the container's path, which is no path here.
  const dir = fresh("agent-dangling");
  for (const name of ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]) symlinkSync("/home/agent/notes/missing.md", path.join(dir, name));
  assert.equal(isInitialised(dir), true, "the wizard cannot write through the links, so it cannot be asked for");
  assert.equal(agentFileStatus(dir).initialised, true);
  // Said of each, so that the page shows a link as one and not as an empty editor that cannot be saved.
  const status = agentFileStatus(dir).files;
  assert.deepEqual(status.map((f) => [f.name, f.link]), [["SOUL.md", true], ["PrimaryUser.md", true], ["MEMORY.md", true], ["WATCH.md", false]]);
  assert.deepEqual(runWizard({ agentName: "Ada", userName: "Sam" }, dir).kept, ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]);
  assert.equal(isInitialised(dir), true);
  // One file of three gone is still a wizard.
  rmSync(path.join(dir, "MEMORY.md"));
  assert.equal(isInitialised(dir), false);
  runWizard({ agentName: "Ada", userName: "Sam" }, dir);
  assert.equal(isInitialised(dir), true);
});

test("the wizard writes the files that are not there and keeps the ones that are", () => {
  const dir = fresh("agent-kept");
  writeFileSync(path.join(dir, "SOUL.md"), "# Ada, written by hand\n");
  writeFileSync(path.join(dir, "PrimaryUser.md"), "# Sam, written by hand\n");
  writeFileSync(path.join(dir, "MEMORY.md"), "decisions\n");
  assert.deepEqual(runWizard({ agentName: "Ada", userName: "Someone else" }, dir).kept, ["SOUL.md", "PrimaryUser.md", "MEMORY.md"]);
  assert.equal(readFileSync(path.join(dir, "SOUL.md"), "utf8"), "# Ada, written by hand\n");
  assert.equal(readFileSync(path.join(dir, "PrimaryUser.md"), "utf8"), "# Sam, written by hand\n");
  rmSync(path.join(dir, "PrimaryUser.md"));
  assert.deepEqual(runWizard({ agentName: "Ada", userName: "Someone else" }, dir).kept, ["SOUL.md", "MEMORY.md"]);
  assert.match(readFileSync(path.join(dir, "PrimaryUser.md"), "utf8"), /Someone else/);
  assert.equal(readFileSync(path.join(dir, "SOUL.md"), "utf8"), "# Ada, written by hand\n");
  assert.deepEqual(left(dir), []);
});

test("a project's instructions are saved whole, and not over what the agent wrote since", () => {
  const root = fresh("projects");
  P.createProject(root, "demo", "Use tabs.");
  const read = P.readInstructions(root, "demo");
  assert.equal(read.text, "Use tabs.\n");
  assert.ok(read.mtime > 0);
  P.writeInstructions(root, "demo", "Use tabs. Be brief.", read.mtime);
  assert.equal(P.readInstructions(root, "demo").text, "Use tabs. Be brief.\n");
  assert.deepEqual(left(path.join(root, "demo")), []);
  // The agent appends a rule; the page still shows the older text.
  writeFileSync(path.join(root, "demo", "AGENTS.md"), "Use tabs. Be brief.\nNever force-push.\n");
  assert.throws(() => P.writeInstructions(root, "demo", "Use spaces.", read.mtime - 5000), (e) => e instanceof P.ProjectError && e.code === "conflict");
  assert.equal(P.readInstructions(root, "demo").text, "Use tabs. Be brief.\nNever force-push.\n");
  // Clearing is a save like another.
  assert.throws(() => P.writeInstructions(root, "demo", "", read.mtime - 5000), (e) => e instanceof P.ProjectError && e.code === "conflict");
  assert.ok(existsSync(path.join(root, "demo", "AGENTS.md")));
  // No time sent: the old behaviour, which is what "save mine anyway" does.
  P.writeInstructions(root, "demo", "Use spaces.");
  assert.equal(P.readInstructions(root, "demo").text, "Use spaces.\n");
  // A file there was none of when the page read it.
  P.writeInstructions(root, "demo", "");
  assert.throws(() => P.writeInstructions(root, "demo", "Fresh.", 12345), (e) => e instanceof P.ProjectError && e.code === "conflict");
  P.writeInstructions(root, "demo", "Fresh.", 0);
  assert.equal(P.readInstructions(root, "demo").text, "Fresh.\n");
});

test("instructions that fail to save halfway are as they were", { skip: !hasPrlimit && "prlimit is not available" }, () => {
  const root = fresh("projects-full");
  P.createProject(root, "keep", "The rules.");
  const { out } = underLimit(20_000, `import { writeInstructions } from ${JSON.stringify(dist("projects.js"))};
    ${FAILS.replace("RUN", `writeInstructions(${JSON.stringify(root)}, "keep", "q".repeat(90_000))`)}`);
  assert.equal(out, "EFBIG");
  assert.equal(P.readInstructions(root, "keep").text, "The rules.\n");
  assert.deepEqual(left(path.join(root, "keep")), []);
});

test("deleting a folder from the files panel does not hold the server up while the tree goes", async () => {
  const dir = fresh("files-rm");
  mkdirSync(path.join(dir, "tree", "a", "b"), { recursive: true });
  for (let i = 0; i < 50; i++) writeFileSync(path.join(dir, "tree", "a", "b", `f${i}`), "x");
  const removing = removeEntry(dir, "tree", true);
  // rmSync would have finished before the call returned.
  assert.ok(existsSync(path.join(dir, "tree")), "the removal runs off the thread");
  await removing;
  assert.ok(!existsSync(path.join(dir, "tree")));
});

test("a project folder is out of the way at once and removed after, and a stop in between is cleaned up", async () => {
  const root = fresh("projects-rm");
  P.createProject(root, "gone", "x");
  mkdirSync(path.join(root, "gone", "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(root, "gone", "node_modules", "pkg", "index.js"), "x");
  P.deleteProjectFolder(root, "gone");
  assert.ok(!existsSync(path.join(root, "gone")), "the name is free at once");
  assert.ok(readdirSync(root).some((n) => n.startsWith(".deleting-")), "and the tree is still being taken away, not waited for");
  assert.deepEqual(P.listProjects(root), []);
  for (let i = 0; i < 100 && readdirSync(root).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(readdirSync(root), [], "and the tree goes shortly after");

  // What a stop left: a folder put aside and not removed. Folders of the user's own that start the same way are not it.
  mkdirSync(path.join(root, ".deleting-0123456789ab", "deep"), { recursive: true });
  mkdirSync(path.join(root, ".deleting-later"));
  mkdirSync(path.join(root, ".deleting-0123456789abc"));
  mkdirSync(path.join(root, "kept"));
  sweepRemoved(root);
  for (let i = 0; i < 100 && readdirSync(root).includes(".deleting-0123456789ab"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(readdirSync(root).sort(), [".deleting-0123456789abc", ".deleting-later", "kept"]);
});

test("deleting and renaming refuse the same places", async () => {
  const dir = fresh("entry-place");
  const outside = fresh("entry-place-outside");
  writeFileSync(path.join(outside, "precious"), "keep");
  symlinkSync(outside, path.join(dir, "out"));
  writeFileSync(path.join(dir, "file"), "x");
  const bad = ["", ".", "..", "../x", "out/precious", "file\0", "missing", "sub/../.."];
  for (const rel of bad) {
    const rename = (() => { try { renameEntry(dir, rel, "other"); return "ok"; } catch (e) { return e.code; } })();
    const remove = await removeEntry(dir, rel, true).then(() => "ok", (e) => e.code);
    assert.equal(rename, remove, `${JSON.stringify(rel)}: rename says ${rename}, delete says ${remove}`);
    assert.notEqual(remove, "ok", JSON.stringify(rel));
  }
  assert.equal(readFileSync(path.join(outside, "precious"), "utf8"), "keep");
});
