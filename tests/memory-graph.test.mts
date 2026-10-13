import { test } from "node:test";
import assert from "node:assert/strict";
import { bounds, colours, graphModeFrom, layout, layoutKept, neighbours, placeLabels, roundsFor } from "../web/src/memory-graph.ts";

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

test("one note, or none, is laid out and boxed without trouble", () => {
  assert.deepEqual(layout([], []), []);
  const [only] = layout(["/x.md"], []);
  assert.ok(Math.abs(only.x) < 1e-6 + 60 && Number.isFinite(only.y));
  // Never drawn closer than the least box: three notes do not fill the page.
  const box = bounds([only]);
  assert.deepEqual([box.width, box.height], [720, 480]);
  assert.ok(Math.abs(box.x + box.width / 2 - only.x) < 1e-6, "centred on it");
  assert.deepEqual(bounds([]), { x: -360, y: -240, width: 720, height: 480 });
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

test("each note's neighbours are those it links to and those that link to it", () => {
  const near = neighbours([{ source: "/a.md", target: "/b.md" }, { source: "/c.md", target: "/a.md" }, { source: "/a.md", target: "/a.md" }]);
  assert.deepEqual([...near.get("/a.md")!].sort(), ["/b.md", "/c.md"]);
  assert.deepEqual([...near.get("/b.md")!], ["/a.md"]);
  assert.equal(near.get("/d.md"), undefined);
});

const meets = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

test("labels never cover each other: one with no room below moves aside, and one with no room anywhere is left out", () => {
  // A crowd of notes with long names, closer together than their labels are wide.
  const asks = Array.from({ length: 80 }, (_, i) => ({ path: `/n${i}.md`, x: (i % 10) * 40, y: Math.floor(i / 10) * 30, r: 6, width: 150, height: 14 }));
  const placed = placeLabels(asks, 2);
  assert.ok(placed.length > 5 && placed.length < 80, `${placed.length}`);
  for (const a of placed) for (const b of placed) if (a !== b) assert.ok(!meets(a.box, b.box), `${a.path} and ${b.path}`);
  // Nor over another note.
  for (const l of placed) for (const n of asks) if (n.path !== l.path) assert.ok(!meets(l.box, { x0: n.x - n.r, y0: n.y - n.r, x1: n.x + n.r, y1: n.y + n.r }), `${l.path} over ${n.path}`);
  // The first asked comes first: it is the one placed, below its note.
  assert.equal(placed[0].path, "/n0.md");
  assert.equal(placed[0].anchor, "middle");
  assert.ok(placed[0].y > asks[0].y);
});

test("a label goes above, or beside, when below is taken", () => {
  const two = placeLabels(
    [
      { path: "/first.md", x: 0, y: 0, r: 6, width: 60, height: 14 },
      // Just over the first: below it, its label would lie on the first note.
      { path: "/over.md", x: 0, y: -22, r: 6, width: 60, height: 14 },
    ],
    2,
  );
  const of = (p: string) => two.find((l) => l.path === p)!;
  assert.equal(of("/first.md").anchor, "middle");
  assert.ok(of("/first.md").y > 0, "below");
  assert.equal(of("/over.md").anchor, "middle");
  assert.ok(of("/over.md").y < -22, "above its note");
  assert.ok(!meets(two[0].box, two[1].box));
  // Between two notes close above and below it, only beside is free.
  const [between] = placeLabels(
    [
      { path: "/between.md", x: 0, y: 0, r: 6, width: 60, height: 14 },
      { path: "/up.md", x: 0, y: -18, r: 6, width: 4, height: 4 },
      { path: "/down.md", x: 0, y: 18, r: 6, width: 4, height: 4 },
    ],
    2,
  );
  assert.equal(between.path, "/between.md");
  assert.equal(between.anchor, "start");
  assert.ok(between.box.x0 >= 6);
});

test("the chosen note keeps its label even where it can only go over other notes", () => {
  const ring = Array.from({ length: 12 }, (_, i) => ({ path: `/r${i}.md`, x: Math.cos(i / 2) * 12, y: Math.sin(i / 2) * 12, r: 6, width: 8, height: 8 }));
  const chosen = { path: "/chosen.md", x: 0, y: 0, r: 4, width: 40, height: 14, must: true };
  assert.equal(placeLabels([{ ...chosen, must: false }, ...ring], 2).some((l) => l.path === "/chosen.md"), false);
  assert.equal(placeLabels([chosen, ...ring], 2)[0].path, "/chosen.md");
});

test("the graph is flat unless 3D was chosen in this browser", () => {
  assert.equal(graphModeFrom("3d"), "3d");
  assert.equal(graphModeFrom("2d"), "2d");
  assert.equal(graphModeFrom(null), "2d", "nothing kept, or storage that cannot be read");
  assert.equal(graphModeFrom("4d"), "2d");
});

test("a label stays inside the box the graph is shown in, on whichever side of its note there is room", () => {
  const edge = { x0: -100, y0: -100, x1: 100, y1: 100 };
  // At the right edge, a label centred under it would be cut off: it goes to the left of it.
  const [right] = placeLabels([{ path: "/right.md", x: 90, y: 0, r: 6, width: 60, height: 14 }], 2, edge);
  assert.equal(right.anchor, "end");
  assert.ok(right.box.x0 >= -100 && right.box.x1 <= 100, "not past the edge");
  // In the bottom right corner too.
  const [corner] = placeLabels([{ path: "/corner.md", x: 92, y: 92, r: 6, width: 60, height: 14 }], 2, edge);
  assert.equal(corner.anchor, "end");
  // Without the box, the same label goes below as always.
  assert.equal(placeLabels([{ path: "/corner.md", x: 92, y: 92, r: 6, width: 60, height: 14 }], 2)[0].anchor, "middle");
  // No room anywhere inside: left out.
  assert.deepEqual(placeLabels([{ path: "/big.md", x: 0, y: 0, r: 6, width: 400, height: 14 }], 2, edge), []);
});
