import { test } from "node:test";
import assert from "node:assert/strict";
import { withModeParams } from "../dist/pi/request-params.js";

/** What the wrapped stream function was called with. */
function wrapped(params) {
  const calls = [];
  const next = (model, context, options, ...rest) => (calls.push({ model, context, options, rest }), "stream");
  return { call: withModeParams(next, () => params), calls };
}

test("the mode's values are added to the options of a request, and what the options held stays", () => {
  const { call, calls } = wrapped({ temperature: 0.2, topP: 0.9, topK: 20, minP: 0.05, maxTokens: 512 });
  assert.equal(call({ maxTokens: 4000 }, "ctx", { reasoning: "high", samplingParams: { repeat_penalty: 1.1, top_k: 99 } }, "extra"), "stream");
  assert.deepEqual(calls[0].options, {
    reasoning: "high",
    temperature: 0.2,
    samplingParams: { repeat_penalty: 1.1, top_p: 0.9, top_k: 20, min_p: 0.05 },
    maxTokens: 512,
  });
  assert.deepEqual(calls[0].rest, ["extra"]);
});

test("a request with no options, and a mode that sets one field, get that field only", () => {
  const { call, calls } = wrapped({ topP: 0.5 });
  call({ maxTokens: 100 }, "ctx", undefined);
  assert.deepEqual(calls[0].options, { samplingParams: { top_p: 0.5 } });
  const t = wrapped({ temperature: 0 });
  t.call({}, "ctx", {});
  assert.deepEqual(t.calls[0].options, { temperature: 0 }, "zero is set");
});

test("the temperature goes into samplingParams only where the model's own entry has one to beat", () => {
  // Without one, the adapter's guard decides: a ChatGPT sign-in's requests must not carry a temperature, and a copy in
  // samplingParams would get past it.
  const { call, calls } = wrapped({ temperature: 0.3 });
  call({ maxTokens: 100 }, "ctx", {});
  call({ samplingParams: { top_k: 40 }, samplingParamsByThinkingLevel: { high: {} } }, "ctx", {});
  assert.deepEqual(calls.map((c) => c.options), [{ temperature: 0.3 }, { temperature: 0.3 }]);
  call({ samplingParams: { temperature: 0.7 } }, "ctx", {});
  call({ samplingParamsByThinkingLevel: { high: { temperature: 1 } } }, "ctx", {});
  assert.deepEqual(calls.slice(2).map((c) => c.options), [
    { temperature: 0.3, samplingParams: { temperature: 0.3 } },
    { temperature: 0.3, samplingParams: { temperature: 0.3 } },
  ]);
});

test("the maximum is held to the model's, and taken as it is where the model has none", () => {
  const { call, calls } = wrapped({ maxTokens: 5000 });
  call({ maxTokens: 800 }, "ctx", {});
  call({}, "ctx", {});
  call({ maxTokens: 0 }, "ctx", {});
  assert.deepEqual(calls.map((c) => c.options.maxTokens), [800, 5000, 5000]);
});

test("a request that names its own maximum, as a compaction or a summary does, and a chat with no parameters, are left as they are", () => {
  const set = wrapped({ temperature: 0.2, maxTokens: 50 });
  const options = { maxTokens: 16000, cacheRetention: "none" };
  set.call({ maxTokens: 100 }, "ctx", options);
  assert.equal(set.calls[0].options, options, "the same object, untouched");
  const none = wrapped(undefined);
  const plain = { reasoning: "low" };
  none.call({ maxTokens: 100 }, "ctx", plain);
  assert.equal(none.calls[0].options, plain);
});

test("the parameters are read at each request", () => {
  let params = { temperature: 0.1 };
  const calls = [];
  const call = withModeParams((m, c, options) => calls.push(options), () => params);
  call({}, "ctx", {});
  params = undefined;
  call({}, "ctx", {});
  params = { temperature: 0.9 };
  call({}, "ctx", {});
  assert.deepEqual(calls.map((o) => o.temperature), [0.1, undefined, 0.9]);
});
