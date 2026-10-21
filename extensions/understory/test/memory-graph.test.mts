import { test } from "node:test";
import assert from "node:assert/strict";
import { colours, roundsFor } from "../src/web/memory-graph.ts";

test("the memory's types never share a colour, the first ten of them", () => {
  const types = ["People", "Test Infrastructure", "Deployment Process", "People"];
  const colourOf = colours(types);
  assert.equal(new Set(types.map(colourOf)).size, 3);
  assert.equal(colourOf("People"), colours(["People", "Test Infrastructure", "Deployment Process"])("People"), "the same memory, the same colours");
  assert.match(colourOf("Unheard of"), /^#/);
  assert.match(colourOf(undefined), /^#/);
});

test("the rounds fall as the notes grow, so that the work stays what a page can do at once", () => {
  assert.equal(roundsFor(0), 300);
  assert.equal(roundsFor(5), 300);
  assert.equal(roundsFor(400), 300, "a memory of a few hundred is laid out as it always was");
  let before = 300;
  for (const n of [450, 800, 1500, 5000, 100_000]) {
    const rounds = roundsFor(n);
    assert.ok(rounds <= before && rounds >= 20, `${n}: ${rounds}`);
    before = rounds;
  }
  assert.ok(roundsFor(450) < 300 && roundsFor(800) < roundsFor(450) && roundsFor(1500) < roundsFor(800));
  // Pairs looked at in all: 1,500 notes were 337 million, and are a twelfth of that.
  assert.ok(roundsFor(1500) * ((1500 * 1499) / 2) < 30_000_000);
});
