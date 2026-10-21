import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeModel } from "./fake-model.mjs";
import { freePort, inProcessHome, runToEnd, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * A server half that crashes, in a timer, a promise nobody waits on, or by calling process.exit(), is stopped and held
 * off, with those that build on it; the portal goes on. A tool's call into it that is pending ends at once with the
 * crash and its last lines, so the agent reads it in the same turn. Each in a process of its own: what a crash does
 * is the process's (extension-crash-child.mjs). Then the whole server, with a real chat.
 */
const home = inProcessHome("pithagoras-extension-crashes-");
const CHILD = fileURLToPath(new URL("./extension-crash-child.mjs", import.meta.url));

/** A scenario of the child's, in a home of its own. */
async function scenario(name) {
  const { code, out, err } = await runToEnd([CHILD, name], serverEnv(testHome("pithagoras-extension-crash-child-"), 0));
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  return { code, err, result: line && JSON.parse(line.slice("RESULT ".length)) };
}

const HELD = /^It crashed at \S+: (.*)\. It stays off until another revision of it is installed, or it is switched off and on\.$/;

test("one that throws in a timer is held, with what requires it; the rest runs; another revision starts", async () => {
  const { code, err, result } = await scenario("timer");
  assert.equal(code, 0, err);
  assert.deepEqual(result.started, [true, true, true, true, true, true]);
  const { crashy, needs, likes, other, parser, micro } = result.after;
  assert.equal(crashy.running, false);
  assert.equal(HELD.exec(crashy.failure)?.[1], "Error: thrown in a timer");
  assert.deepEqual({ ...crashy.crash, at: undefined, stack: undefined }, { name: "crashy", rev: "r1", at: undefined, error: "Error: thrown in a timer", stack: undefined });
  assert.match(crashy.crash.stack, /halves\/crashy\/server\.js/);
  // What it said, and what its code printed, the crash last.
  assert.deepEqual(crashy.lines.slice(0, 3), ["[extension crashy] starting", "printed by its own code", "[extension crashy] server half started"]);
  assert.match(crashy.lines.at(-1), /^\[extension crashy\] its server half crashed\. .*Error: thrown in a timer/s);
  assert.equal(needs.running, false, "what requires it is stopped with it");
  assert.equal(likes, true, "what only uses it where it is there runs on without it");
  assert.equal(other, true);
  // One whose timer threw with nothing of its own in the stack is known by the code that set it.
  assert.match(parser.crash.error, /^SyntaxError: /);
  assert.doesNotMatch(parser.crash.stack, /halves\/parser/);
  // One whose error came by a way Node does not follow is known by its folder.
  assert.equal(micro.crash.error, "Error: thrown in a microtask");
  assert.equal(result.sameRevision, false, "the revision that crashed is not started again");
  assert.equal(result.fixed.running, true, "another revision is");
  assert.equal(result.fixed.crash, undefined);
  assert.equal(result.needs, true);
});

test("one whose promise rejects with nobody to hear it, from a route, is held; switched off and on, it starts again", async () => {
  const { code, err, result } = await scenario("rejection");
  assert.equal(code, 0, err);
  assert.deepEqual(result.answered, { status: 200, body: { answered: true } });
  assert.equal(result.after.running, false);
  assert.equal(result.after.crash.error, "TypeError: fetch failed");
  assert.doesNotMatch(result.after.crash.stack, /halves\/rejecting/, "known by the route it came from, not by its stack");
  assert.equal(result.route.status, 404, "its routes are gone with it");
  assert.equal(result.again, true);
});

test("one that calls process.exit() has crashed, and the portal goes on", async () => {
  const { code, err, result } = await scenario("exit");
  assert.equal(code, 0, err);
  assert.deepEqual(result.hello, { status: 200, body: { hello: true } });
  assert.deepEqual(result.quit, { status: 500, body: { error: "It called process.exit(3)" } }, "the request is answered");
  assert.equal(result.after.status, 404);
  assert.equal(result.quitter.crash.error, "Error: It called process.exit(3)");
  assert.equal(result.timed.crash.error, "Error: It called process.exit(4)");
  assert.equal(result.timed.running, false);
});

test("a tool's call pending in one that crashes ends at once with the crash and its last lines; a later call does not run it", async () => {
  const { code, err, result } = await scenario("tool");
  assert.equal(code, 0, err);
  assert.match(result.pending, /^The server half of tooly crashed: Error: the tool's timer threw\. The call was not answered\. It is off until another revision of it is installed, or it is switched off and on\.\n\nIts last lines:\n/);
  assert.match(result.pending, /INFO {2}\[extension tooly\] working on it\n.*ERROR \[extension tooly\] its server half crashed/);
  assert.ok(result.took < 2000, `answered when it crashed, not later: ${result.took} ms`);
  assert.equal(result.later, result.pending);
  assert.equal(result.calls, 1, "the later call did not run its code");
  assert.deepEqual(result.held, { serving: false, tools: 0 }, "a chat that loads now has none of its tools");
  assert.deepEqual(result.fixed, { content: [{ type: "text", text: "done" }], details: {} });
});

test("an error that is no extension's ends the process as Node does: thrown, or a rejection nobody heard", async () => {
  for (const [name, message] of [["ownException", "the portal's own failure"], ["ownRejection", "the portal's own rejection"]]) {
    const { code, err, result } = await scenario(name);
    assert.equal(code, 1, name);
    assert.equal(result, undefined, `${name}: it did not go on`);
    assert.match(err, new RegExp(`Error: ${message}\\n    at Timeout\\._onTimeout`), name);
  }
});

/**
 * The whole server, with a package whose server half adds a tool that crashes it, installed from its folder (a stand-in
 * pi lists it), and a model that calls the tool at each message, and is done once it has its answer.
 */
const bin = path.join(home, "bin");
const pkg = path.join(home, "packages", "crashy");
mkdirSync(bin, { recursive: true });
mkdirSync(pkg, { recursive: true });
writeFileSync(path.join(bin, "pi"), `#!/bin/bash\n[ "$1" = list ] || exit 0\nprintf 'User packages:\\n  %s\\n    %s\\n' ${JSON.stringify(pkg)} ${JSON.stringify(pkg)}\n`);
chmodSync(path.join(bin, "pi"), 0o755);
writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "crashy", version: "1.0.0", type: "module", pi: {}, pithagoras: { server: "./server.js" } }));
const SERVER = (revision, execute) => `export default function (portal) {
  portal.router.get("/revision", (req, res) => res.json({ revision: ${revision} }));
  portal.chats.extend((pi) => pi.registerTool({
    name: "crash_now", label: "crash_now", description: "Crashes its server half.", parameters: { type: "object", properties: {} },
    async execute() { ${execute} },
  }));
}
`;
writeFileSync(path.join(pkg, "server.js"), SERVER(1, `portal.log("about to crash"); setTimeout(() => { throw new Error("the tool's timer threw"); }, 50); return new Promise(() => {});`));

const model = await fakeModel((request) => (request.messages.at(-1).role === "user" ? { name: "crash_now", args: {} } : "Done."));
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m", packages: [pkg] }));

let base;
const json = async (url, method = "GET", body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
/** A message in the chat, and the answer its call of the tool had, once the run is over. */
async function turn(chatId, message) {
  const first = model.requests.length;
  await json(`/api/sessions/${chatId}/prompt`, "POST", { message });
  for (let i = 0; i < 400 && !(model.requests.length >= first + 2 && (await json(`/api/sessions/${chatId}`)).status !== "running"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(model.requests.length, first + 2, "the model was asked again, with the call's answer");
  const answer = model.requests[first + 1].messages.at(-1);
  assert.equal(answer.role, "tool");
  return typeof answer.content === "string" ? answer.content : answer.content.map((part) => part.text).join("");
}
const crashyUi = async () => (await json("/api/extension-ui")).extensions.find((ext) => ext.name === "crashy");

test("a real chat: the tool's call that crashes its half comes back as the call's error in the same turn, the chat goes on, and another revision starts it again", async (t) => {
  const server = await startServer(serverEnv(home, await freePort(), { PATH: `${bin}${path.delimiter}${process.env.PATH}` }));
  base = server.base;
  // Stopped with this test: the file's own hooks can run before it does where a run picks tests by name.
  t.after(async () => {
    server.child.kill();
    await once(server.child, "exit");
  });
  assert.deepEqual(await json("/api/x/crashy/revision"), { revision: 1 });
  const chat = await json("/api/sessions", "POST", {});
  const crashed = await turn(chat.id, "Crash it");
  assert.match(crashed, /^The server half of crashy crashed: Error: the tool's timer threw\. The call was not answered\./);
  assert.match(crashed, /\[extension crashy\] about to crash/);
  assert.equal((await json(`/api/sessions/${chat.id}`)).status, "idle", "the run finished as any other");
  // The chat goes on: the tool it still has answers with the crash, at once.
  assert.equal(await turn(chat.id, "Again"), crashed);

  // The portal goes on; the half is off, and says why.
  const ui = await crashyUi();
  assert.equal(ui.server, undefined);
  assert.equal(HELD.exec(ui.serverError)?.[1], "Error: the tool's timer threw");
  assert.equal(ui.crash.error, "Error: the tool's timer threw");
  assert.ok(ui.crash.lines.some((line) => line.endsWith("[extension crashy] about to crash")), ui.crash.lines.join("\n"));
  assert.equal((await fetch(`${base}/api/x/crashy/revision`)).status, 404);

  // Installed again, changed: it runs, and the chat has its tool once it is reloaded.
  writeFileSync(path.join(pkg, "server.js"), SERVER(2, `return { content: [{ type: "text", text: "fine now" }], details: {} };`));
  await json("/api/packages", "POST", { spec: pkg });
  assert.deepEqual(await json("/api/x/crashy/revision"), { revision: 2 });
  const fixed = await crashyUi();
  assert.equal(fixed.crash, undefined);
  assert.equal(fixed.serverError, undefined);
  await json(`/api/sessions/${chat.id}/prompt`, "POST", { message: "/reload" });
  assert.equal(await turn(chat.id, "Once more"), "fine now");
});
