import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome, scratch } from "./server-harness.mjs";

// pi itself, against an agent directory of its own.
inProcessHome("pi-agent-");
const dir = process.env.PI_CODING_AGENT_DIR;
const pi = await import("@earendil-works/pi-coding-agent");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { modelRuntime } = await import("../dist/api/providers.js");
const providersOf = async (rt) => new Set((await rt.getAvailable()).map((m) => m.provider));

test("a key saved in Settings reaches the model menu of a chat already open", async () => {
  const chat = new SdkPiClient({}, await pi.ModelRuntime.create(), () => {});
  const menu = async () => new Set((await chat.getModels()).map((m) => m.provider));
  assert.equal((await menu()).has("openrouter"), false);
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-v1-test" } }));
  assert.equal((await menu()).has("openrouter"), true);
});

test("the models Settings offers include those an installed package brings", async () => {
  const home = scratch("agent-home-");
  assert.equal((await providersOf(await modelRuntime(home))).has("fake-gateway"), false);

  // Installed: pi's settings name it, as `pi install` would.
  mkdirSync(path.join(dir, "ext"), { recursive: true });
  writeFileSync(path.join(dir, "ext", "gateway.js"), `export default function (pi) {
    pi.registerProvider("fake-gateway", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", api: "openai-completions",
      models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] });
  }`);
  // A moment on, so the settings file is seen to have changed.
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "ext", "gateway.js")] }));
  const built = modelRuntime(home);
  const models = await (await built).getAvailable();
  assert.deepEqual(models.filter((m) => m.provider === "fake-gateway").map((m) => m.id), ["m1"]);

  // A default saved rewrites the file, but installs nothing: what was built is kept, and no extension runs again.
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "ext", "gateway.js")], defaultModel: "m1" }));
  assert.equal(modelRuntime(home), built);
});

test("a key saved is read into the runtime Settings keeps, without making it again", async () => {
  const home = scratch("agent-home-");
  writeFileSync(path.join(dir, "auth.json"), "{}");
  const before = await modelRuntime(home);
  assert.equal((await providersOf(before)).has("openrouter"), false);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-v1-test" } }));
  const after = await modelRuntime(home);
  assert.equal(after, before, "the same runtime: no extension ran again");
  assert.equal((await providersOf(after)).has("openrouter"), true);
});

test("the effort levels worked out for a model, and the one each level asked for starts on, are pi's", async () => {
  // pi's own, from the copy of pi-ai it uses: beside it when npm hoists it, inside it otherwise.
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const found = ["../node_modules/@earendil-works/pi-ai/dist/models.js", "../../pi-ai/dist/models.js"]
    .map((p) => new URL(p, piEntry))
    .find((u) => existsSync(fileURLToPath(u)));
  assert.ok(found, "pi-ai was not found beside pi");
  const { getSupportedThinkingLevels, clampThinkingLevel } = await import(found.href);
  const { thinkingLevelsOf, clampLevel } = await import("../dist/pi/model-runtime.js");

  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const maps = [
    undefined,
    {},
    Object.fromEntries(levels.map((l) => [l, ["off", "medium"].includes(l) ? l : null])),
    { xhigh: "xhigh" },
    { max: "max", off: null },
    { low: "low", medium: "medium", xhigh: "xhigh", minimal: null, high: null, off: null, max: null },
  ];
  for (const reasoning of [true, false, undefined]) {
    for (const thinkingLevelMap of maps) {
      const model = { reasoning, thinkingLevelMap };
      assert.deepEqual(thinkingLevelsOf(model), getSupportedThinkingLevels(model), JSON.stringify(model));
      // And the level each asked-for one is started on.
      for (const level of [...levels, "unheard-of"]) {
        assert.equal(clampLevel(thinkingLevelsOf(model), level), clampThinkingLevel(model, level), `${level} on ${JSON.stringify(model)}`);
      }
    }
  }
});
