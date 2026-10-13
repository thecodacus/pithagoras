import { test } from "node:test";
import assert from "node:assert/strict";
import { colours, graphModeFrom, layout, layoutKept, roundsFor } from "../web/src/memory-graph.ts";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test("linked notes end up closer than unlinked ones, the same way every time", () => {
  const paths = ["/a.md", "/b.md", "/c.md", "/d.md", "/e.md"];
  const edges = [{ source: "/a.md", target: "/b.md" }, { source: "/b.md", target: "/c.md" }, { source: "/gone.md", target: "/a.md" }];
  const one = layout(paths, edges);
  assert.deepEqual(one, layout(paths, edges));
  assert.ok(one.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  const at = Object.fromEntries(one.map((p) => [p.path, p]));
  assert.ok(dist(at["/a.md"], at["/b.md"]) < dist(at["/a.md"], at["/e.md"]));
  // Nobody on top of anybody.
  for (const p of one) for (const q of one) if (p !== q) assert.ok(dist(p, q) > 20, `${p.path} and ${q.path} apart`);
});

test("one note, or none, is laid out without trouble", () => {
  assert.deepEqual(layout([], []), []);
  const [only] = layout(["/x.md"], []);
  assert.ok(Math.abs(only.x) < 1e-6 + 60 && Number.isFinite(only.y));
});

test("the memory's types never share a colour, the first ten of them", () => {
  const types = ["People", "Test Infrastructure", "Deployment Process", "People"];
  const colourOf = colours(types);
  assert.equal(new Set(types.map(colourOf)).size, 3);
  assert.equal(colourOf("People"), colours(["People", "Test Infrastructure", "Deployment Process"])("People"), "the same memory, the same colours");
  assert.match(colourOf("Unheard of"), /^#/);
  assert.match(colourOf(undefined), /^#/);
});

const chain = (n: number) => {
  const paths = Array.from({ length: n }, (_, i) => `/n${i}.md`);
  return { paths, edges: paths.slice(1).map((target, i) => ({ source: paths[i], target })) };
};

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

test("a layout is run for the rounds its size gets, unless it is told how many", () => {
  const { paths, edges } = chain(450);
  const asked = layout(paths, edges);
  assert.deepEqual(asked, layout(paths, edges, roundsFor(450)));
  assert.notDeepEqual(asked, layout(paths, edges, 300));
});

test("a memory of thousands of notes is laid out at once, finite, spread, and not far off", () => {
  const { paths, edges } = chain(2000);
  const started = Date.now();
  const placed = layout(paths, edges);
  assert.ok(Date.now() - started < 5000, "bounded work");
  assert.equal(placed.length, 2000);
  assert.ok(placed.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  // The start is near rest: nothing is left thousands of units out, for want of rounds to walk in.
  const far = Math.max(...placed.map((p) => Math.hypot(p.x, p.y)));
  assert.ok(far < 5000, `${far}`);
  const seen = new Set(placed.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
  assert.ok(seen.size > 1900, "not piled up");
});

test("opening the graph for the same memory again does not lay it out again", () => {
  const { paths, edges } = chain(30);
  const one = layoutKept(paths, edges);
  assert.equal(layoutKept([...paths], edges.map((e) => ({ ...e }))), one, "the same notes and links, the same layout");
  assert.notEqual(layoutKept(paths.slice(1), edges.slice(1)), one);
  assert.notEqual(layoutKept(paths, edges.slice(1)), one, "another link is another layout");
});

test("the graph is flat unless 3D was chosen in this browser", () => {
  assert.equal(graphModeFrom("3d"), "3d");
  assert.equal(graphModeFrom("2d"), "2d");
  assert.equal(graphModeFrom(null), "2d", "nothing kept, or storage that cannot be read");
  assert.equal(graphModeFrom("4d"), "2d");
});
