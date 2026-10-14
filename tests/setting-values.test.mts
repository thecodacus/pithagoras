import test from "node:test";
import assert from "node:assert/strict";
import { typed } from "../core/web/src/setting-values.ts";
import { looksComplete } from "../core/web/src/provider-address.ts";

test("a setting not set before is stored as what its text is", () => {
  assert.equal(typed(undefined, "false", "enableX"), false, 'as text, "false" is on to `if (settings.x)`');
  assert.equal(typed(undefined, "TRUE", "enableX"), true);
  assert.equal(typed(undefined, "8080", "port"), 8080);
  assert.equal(typed(undefined, "0.5", "temperature"), 0.5);
  // Text however it looks, by its name, or by its shape.
  assert.equal(typed(undefined, "0123", "port"), "0123");
  assert.equal(typed(undefined, "12345", "braveApiKey"), "12345");
  assert.equal(typed(undefined, "42", "modelId"), "42");
  assert.equal(typed(undefined, "hello", "greeting"), "hello");
  // One set before keeps its kind.
  assert.equal(typed("x", "false", "mode"), "false");
  assert.equal(typed(3, "4", "count"), 4);
  assert.equal(typed(true, "false", "on"), false);
});

test("an address is asked only once it is whole", () => {
  for (const whole of ["localhost", "gpu", "gpu:8080", "http://gpu:8080/v1", "192.168.1.20:8080", "https://api.example.com/v1", "[::1]:8080"]) {
    assert.equal(looksComplete(whole), true, whole);
  }
  for (const typing of ["", "http://", "192.168.", "192.168.1", "gpu:", "gpu.", "host a", "999.1.1.1"]) {
    assert.equal(looksComplete(typing), false, typing);
  }
});
