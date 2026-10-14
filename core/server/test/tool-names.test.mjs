import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("pithagoras-names-");
const { toolGroupNames, setToolGroupNames } = await import("../dist/db.js");

test("nothing named is an empty map, not a failure", () => {
  assert.deepEqual(toolGroupNames(), {});
});

test("a name is kept, trimmed, against the package it was given for", () => {
  setToolGroupNames({ "@forecastx/deep-research": "  Deep Research  ", browser: "Browser" });
  assert.deepEqual(toolGroupNames(), {
    "@forecastx/deep-research": "Deep Research",
    browser: "Browser",
  });
});

test("clearing a name takes it away rather than storing an empty heading", () => {
  setToolGroupNames({ browser: "Browser", "pi-lens": "" });
  assert.deepEqual(toolGroupNames(), { browser: "Browser" });
  setToolGroupNames({});
  assert.deepEqual(toolGroupNames(), {});
});

test("a name is a heading, so it has a length", () => {
  setToolGroupNames({ browser: "x".repeat(200) });
  assert.equal(toolGroupNames().browser.length, 60);
});

test("what is not a name is not stored", () => {
  setToolGroupNames({ browser: 42, "": "nameless", "pi-lens": null, canvases: "Canvases" });
  assert.deepEqual(toolGroupNames(), { canvases: "Canvases" });
});
