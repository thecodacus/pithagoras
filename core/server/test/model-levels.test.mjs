import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// pi's catalogue, against an agent directory of its own, with an installed
// extension — the build runs its code.
inProcessHome("pi-agent-levels-");
const dir = process.env.PI_CODING_AGENT_DIR;
const map = (on) => Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => [l, on.includes(l) ? l : null]));
writeFileSync(path.join(dir, "models.json"), JSON.stringify({
  providers: {
    "test-server": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "none",
      models: [{ id: "switch", name: "Switch", reasoning: true, thinkingLevelMap: map(["off", "medium"]), input: ["text"], contextWindow: 1000, maxTokens: 100 }],
    },
  },
}));
mkdirSync(path.join(dir, "ext"), { recursive: true });
writeFileSync(path.join(dir, "ext", "noop.js"), "export default function () {}");
writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "ext", "noop.js")] }));

const { modelLevels } = await import("../dist/api/providers.js");
const home = process.env.AGENT_HOME;

test("a chat's levels do not wait for pi's catalogue to be built", async () => {
  // Opening an idle chat asks for them. Waiting for the build — every
  // extension's code, loaded — held the answer up to 1.5s after each start
  // or install, where the page has what it last saw to draw meanwhile.
  //
  // The build is held on a promise of the test's own, and the clock is the
  // test's too, so that how long anything takes is not what is measured. Once
  // the wait the chat has is over, the answer is there although the build is
  // still pending: it did not wait for it. One that waits for the build, or
  // for longer than it is given, is not there, however slow the machine is.
  const pi = await import("@earendil-works/pi-coding-agent");
  const { modelRuntime } = await import("../dist/api/providers.js");
  const create = pi.ModelRuntime.create;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started = false;
  pi.ModelRuntime.create = async (...args) => {
    started = true;
    await held;
    return create.apply(pi.ModelRuntime, args);
  };
  // Only setTimeout, and only around the call: setImmediate stays real, to let what is ready run.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let answer;
    modelLevels("test-server", "switch").then((levels) => { answer = levels; });
    mock.timers.tick(150);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(answer, [], "the levels waited for the catalogue to be built, or for more than the wait they have");
    // The build was started, and is still going: that is what was not waited for.
    assert.equal(started, true, "the build was not started");
  } finally {
    mock.timers.reset();
    release();
    pi.ModelRuntime.create = create;
  }

  // Once it is built, the next chat opened has them.
  await modelRuntime();
  assert.deepEqual(await modelLevels("test-server", "switch"), ["off", "medium"]);
});

test("after a failed build, one made since is used at once", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const { modelRuntime } = await import("../dist/api/providers.js");
  const create = pi.ModelRuntime.create;
  // Something else installed, so the catalogue is made anew — and that fails.
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [] }));
  pi.ModelRuntime.create = async () => { throw new Error("catalogue broke"); };
  try {
    assert.deepEqual(await modelLevels("test-server", "switch"), []);
    await modelRuntime().catch(() => {});
  } finally {
    pi.ModelRuntime.create = create;
  }
  // Settings, opened, builds it again, and that works. The chats opened in the
  // rest of the minute had no levels all the same: the wait after a failure
  // was looked at before whether there was a catalogue.
  await modelRuntime();
  assert.deepEqual(await modelLevels("test-server", "switch"), ["off", "medium"]);
});

test("a failed read of pi's files keeps the catalogue built", async () => {
  const { modelRuntime } = await import("../dist/api/providers.js");
  const rt = await modelRuntime();
  assert.deepEqual(await modelLevels("test-server", "switch"), ["off", "medium"]);
  // A file caught half written, say: the next read of them fails once.
  const refresh = rt.refresh.bind(rt);
  rt.refresh = async () => { rt.refresh = refresh; throw new Error("half written"); };
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({}));
  // Before, the catalogue was thrown away with it, and for a minute no chat
  // had levels — then every extension ran again to build another.
  assert.deepEqual(await modelLevels("test-server", "switch", 2000), ["off", "medium"]);
  assert.equal(await modelRuntime(), rt);
});
