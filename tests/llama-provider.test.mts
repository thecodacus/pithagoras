import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./helpers.mts";

// Which providers are llama.cpp servers: one answer for the prefill progress and for the first spoken turn,
// by the kind saved on the Providers page, else by name.
inProcessHome("llama-provider-");
const server = (baseUrl: string) => ({ baseUrl, api: "openai-completions", apiKey: "none", models: [{ id: "m" }] });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify({ providers: {
  "gpu-box": server("http://gpu.example.test:8080/v1"),
  "llama-swap-2": server("http://swap.example.test:8080/v1"),
  "swap-by-kind": server("http://swap2.example.test:8080/v1"),
  openrouter: server("https://openrouter.example.test/v1"),
  "mine": server("http://other.example.test:9000/v1"),
} }));
// What the Providers page saved: a name that says nothing, and one that says the wrong thing.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "portal-providers.json"), JSON.stringify({ "gpu-box": "llama-cpp", "swap-by-kind": "llama-swap", "llama-swap-2": "custom" }));

const { isLlamaProvider } = await import("../core/server/src/providers.js");
const { VoiceFirstTurn } = await import("../core/server/src/pi/voice-first.js");
const { viaProgressProxy } = await import("../core/server/src/pi/sdk-client.js");
const { forgetSession, startLlamaProxy } = await import("../core/server/src/llama-progress.js");

test("a provider is a llama server by the kind saved for it, else by its name", () => {
  assert.equal(isLlamaProvider("gpu-box"), true, "a name that says nothing, saved as llama.cpp");
  assert.equal(isLlamaProvider("swap-by-kind"), true, "saved as a llama-swap gateway");
  assert.equal(isLlamaProvider("llama-swap-2"), false, "saved as something else, whatever its name says");
  for (const id of ["llama.cpp", "llama-server=http://box.example.test:8080", "llama-cpp-big", "llama-swap", "llama-swap-3"]) assert.equal(isLlamaProvider(id), true, id);
  for (const id of ["openrouter", "mine", "anthropic", "ollama", "unknown-one", ""]) assert.equal(isLlamaProvider(id), false, id);
  assert.equal(isLlamaProvider(undefined), false);
});

test("the first spoken turn has thinking switched off on every llama server, whatever it is called, and on nothing else", () => {
  const thinking = (provider: string) => {
    const turn = new VoiceFirstTurn(), handlers = new Map<string, (...args: any[]) => any>();
    turn.extension({ on: (name: string, fn: any) => handlers.set(name, fn) });
    turn.arm();
    const payload = { chat_template_kwargs: {}, thinking_budget_tokens: 1024 };
    return handlers.get("before_provider_request")!({ payload }, { model: { provider } })?.chat_template_kwargs?.enable_thinking;
  };
  for (const provider of ["llama.cpp", "llama-server=http://box.example.test:8080", "llama-swap", "gpu-box", "swap-by-kind"]) assert.equal(thinking(provider), false, provider);
  for (const provider of ["openrouter", "mine", "llama-swap-2"]) assert.equal(thinking(provider), undefined, provider);
});

test("a list saved in the voice settings decides instead, by the names in it, whatever the Providers page says", () => {
  const thinking = (provider: string, saved?: string[]) => {
    const turn = new VoiceFirstTurn(() => saved), handlers = new Map<string, (...args: any[]) => any>();
    turn.extension({ on: (name: string, fn: any) => handlers.set(name, fn) });
    turn.arm();
    return handlers.get("before_provider_request")!({ payload: { chat_template_kwargs: {} } }, { model: { provider } })?.chat_template_kwargs?.enable_thinking;
  };
  assert.equal(thinking("gpu-box"), false, "none saved: the kind saved for it");
  assert.equal(thinking("gpu-box", ["llama-swap"]), undefined, "a list that does not name it");
  assert.equal(thinking("gpu-box", ["gpu-box"]), false, "a list that does");
  assert.equal(thinking("openrouter", ["openrouter"]), false, "whatever it is");
  assert.equal(thinking("llama-swap", []), undefined, "an empty list keeps thinking on everywhere");
});

test("the prefill progress goes through the same answer", async () => {
  startLlamaProxy(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const routed = (provider: string) => {
    const model = viaProgressProxy({ provider, baseUrl: "http://gpu.example.test:8080/v1" }, `s-${provider}`);
    forgetSession(`s-${provider}`);
    return model?.baseUrl !== "http://gpu.example.test:8080/v1";
  };
  for (const provider of ["llama.cpp", "llama-swap", "gpu-box", "swap-by-kind"]) assert.equal(routed(provider), true, provider);
  for (const provider of ["openrouter", "mine", "llama-swap-2"]) assert.equal(routed(provider), false, provider);
});

