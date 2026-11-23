import { test } from "node:test";
import assert from "node:assert/strict";
import { withModeParams } from "../dist/pi/request-params.js";

/** What the wrapped stream function was called with. */
function wrapped(params) {
  const calls = [];
  const next = (model, context, options, ...rest) => (calls.push({ model, context, options, rest }), "stream");
  return { call: withModeParams(next, () => params), calls };
}

test("the mode's temperature is added to the options of a request, and what the options held stays", () => {
  const { call, calls } = wrapped({ temperature: 0.2 });
  assert.equal(call({ maxTokens: 4000 }, "ctx", { reasoning: "high", samplingParams: { repeat_penalty: 1.1, top_k: 99 } }, "extra"), "stream");
  assert.deepEqual(calls[0].options, { reasoning: "high", temperature: 0.2, samplingParams: { repeat_penalty: 1.1, top_k: 99 } });
  assert.deepEqual(calls[0].rest, ["extra"]);
  call({}, "ctx", undefined);
  assert.deepEqual(calls[1].options, { temperature: 0.2 }, "a request with no options gets the temperature only");
});

test("zero is a temperature", () => {
  const { call, calls } = wrapped({ temperature: 0 });
  call({}, "ctx", {});
  assert.deepEqual(calls[0].options, { temperature: 0 });
});

test("the temperature goes into samplingParams only where the model's own entry has one to beat", () => {
  // Without one, the adapter's guard decides: a ChatGPT sign-in's requests must not carry a temperature, and a copy in
  // samplingParams would get past it.
  const { call, calls } = wrapped({ temperature: 0.3 });
  call({ maxTokens: 100 }, "ctx", {});
  call({ samplingParams: { top_k: 40 }, samplingParamsByThinkingLevel: { high: {} } }, "ctx", {});
  assert.deepEqual(calls.map((c) => c.options), [{ temperature: 0.3 }, { temperature: 0.3 }]);
  call({ samplingParams: { temperature: 0.7 } }, "ctx", {});
  call({ samplingParamsByThinkingLevel: { high: { temperature: 1 } } }, "ctx", { samplingParams: { top_k: 5 } });
  assert.deepEqual(calls.slice(2).map((c) => c.options), [
    { temperature: 0.3, samplingParams: { temperature: 0.3 } },
    { temperature: 0.3, samplingParams: { top_k: 5, temperature: 0.3 } },
  ]);
});

test("a request that names its own maximum, as a compaction or a summary does, and a chat with no temperature, are left as they are", () => {
  const set = wrapped({ temperature: 0.2 });
  const options = { maxTokens: 16000, cacheRetention: "none" };
  set.call({ maxTokens: 100 }, "ctx", options);
  assert.equal(set.calls[0].options, options, "the same object, untouched");
  for (const params of [undefined, {}]) {
    const none = wrapped(params);
    const plain = { reasoning: "low" };
    none.call({ maxTokens: 100 }, "ctx", plain);
    assert.equal(none.calls[0].options, plain);
  }
});

test("the temperature is read at each request", () => {
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
