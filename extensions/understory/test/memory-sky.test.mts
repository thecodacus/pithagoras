import { test } from "node:test";
import assert from "node:assert/strict";
import { roundsFor } from "../src/web/memory-graph.ts";
import { BRAIN_COLOUR, brainOutline, colourFrom, heart, helixAt, helixOrder, intoBrain, layout3d, layout3dKept, galaxyStars, GALAXY_TURN, LOBES, lobeOf, pick, project, RESTING, ringsFrom, seeded, Shake, skyThemeFrom, turnAround, WINDING } from "../src/web/memory-sky.ts";

const chain = (n: number) => {
  const paths = Array.from({ length: n }, (_, i) => `/n${i}.md`);
  return { paths, edges: paths.slice(1).map((target, i) => ({ source: paths[i], target })) };
};

test("the 3D layout is the same every time, finite, in all three directions, and about a unit across", () => {
  const paths = ["/a.md", "/b.md", "/c.md", "/d.md", "/e.md", "/f.md"];
  const edges = [{ source: "/a.md", target: "/b.md" }, { source: "/b.md", target: "/c.md" }];
  const one = layout3d(paths, edges);
  assert.deepEqual(one, layout3d(paths, edges));
  assert.ok(one.every((p) => [p.x, p.y, p.z].every(Number.isFinite)));
  for (const axis of ["x", "y", "z"] as const) assert.ok(Math.max(...one.map((p) => Math.abs(p[axis]))) > 0.1, `spread along ${axis}`);
  assert.ok(Math.max(...one.map((p) => Math.hypot(p.x, p.y, p.z))) < 2);
  const at = Object.fromEntries(one.map((p) => [p.path, p]));
  const d = (a: string, b: string) => Math.hypot(at[a].x - at[b].x, at[a].y - at[b].y, at[a].z - at[b].z);
  assert.ok(d("/a.md", "/b.md") < d("/a.md", "/f.md"), "linked notes closer");
  assert.deepEqual(layout3d([], []), []);
  assert.equal(layout3d(["/only.md"], []).length, 1);
});

test("a long memory is laid out in 3D at once, and the same one is not laid out again", () => {
  const { paths, edges } = chain(1500);
  const started = Date.now();
  const placed = layout3dKept(paths, edges);
  assert.ok(Date.now() - started < 5000);
  assert.ok(placed.every((p) => [p.x, p.y, p.z].every(Number.isFinite)));
  assert.equal(layout3dKept([...paths], edges), placed);
});

test("a layout is run for the rounds its size gets, unless it is told how many", () => {
  const { paths, edges } = chain(450);
  const asked = layout3d(paths, edges);
  assert.deepEqual(asked, layout3d(paths, edges, roundsFor(450)));
  assert.notDeepEqual(asked, layout3d(paths, edges, 300));
});

test("the camera: what it looks at is in the middle, nearer is larger, and turning it a quarter brings the side to the front", () => {
  const mid = project({ x: 0, y: 0, z: 0 }, RESTING, 800, 600);
  assert.deepEqual([mid.x, mid.y], [400, 300]);
  const flat = { ...RESTING, yaw: 0, pitch: 0 };
  const near = project({ x: 0.5, y: 0, z: -0.5 }, flat, 800, 600);
  const far = project({ x: 0.5, y: 0, z: 0.5 }, flat, 800, 600);
  assert.ok(near.scale > far.scale && near.x > far.x && near.depth < far.depth);
  const turned = project({ x: 1, y: 0, z: 0 }, { ...flat, yaw: Math.PI / 2 }, 800, 600);
  assert.ok(Math.abs(turned.x - 400) < 1e-6, "seen end on");
  assert.ok(Math.abs(turned.depth + 1) < 1e-6, "towards the camera");
  // Zoomed in twice as close, the same point is twice as far from the middle.
  const zoomed = project({ x: 0.3, y: 0, z: 0 }, { ...flat, zoom: 2 }, 800, 600);
  assert.ok(Math.abs(zoomed.x - 400 - 2 * (project({ x: 0.3, y: 0, z: 0 }, flat, 800, 600).x - 400)) < 1e-6);
  // Looking at another point puts that one in the middle.
  const there = project({ x: 0.4, y: -0.2, z: 0.1 }, { ...RESTING, tx: 0.4, ty: -0.2, tz: 0.1 }, 800, 600);
  assert.deepEqual([there.x, there.y], [400, 300]);
});

test("the point under the pointer is the closest one in reach, and of two as close the nearer one", () => {
  const pts = [
    { x: 100, y: 100, depth: 0.5, scale: 1 },
    { x: 104, y: 100, depth: 0, scale: 1 },
    { x: 100, y: 100, depth: -0.5, scale: 1 },
  ];
  assert.equal(pick(pts, 103, 100, () => 10), 1);
  assert.equal(pick(pts, 100, 100, () => 10), 2, "the nearer of the two on top of each other");
  assert.equal(pick(pts, 100, 100, () => 10, (i) => i === 2), 0, "one filtered out is not there to pick");
  assert.equal(pick(pts, 300, 300, () => 10), null);
});

test("the brain is a sketch: a few broken lines, and every note sits inside it", () => {
  const lines = brainOutline();
  assert.deepEqual(lines, brainOutline(), "the same brain each time");
  assert.ok(lines.length > 40 && lines.length < 400, `${lines.length}`);
  const points = lines.reduce((n, l) => n + l.length, 0);
  // Whole rings and folds would be some 1,600 points: most of them are left out.
  assert.ok(points < 1300, `${points}`);
  const xs = lines.flat().map((p) => p[0]);
  const zs = lines.flat().map((p) => p[2]);
  assert.ok(Math.max(...zs) - Math.min(...zs) > Math.max(...xs) - Math.min(...xs), "longer front to back than it is wide");
  const random = seeded(5);
  for (let i = 0; i < 200; i++) {
    const [x, y, z] = intoBrain({ x: random() * 4 - 2, y: random() * 4 - 2, z: random() * 4 - 2 });
    assert.ok((x / 0.62) ** 2 + ((y + 0.08) / 0.42) ** 2 + (z / 0.72) ** 2 <= 1 + 1e-9);
  }
});

test("the theme and the brain's colour read from storage fall back to the defaults", () => {
  assert.equal(skyThemeFrom("brain"), "brain");
  assert.equal(skyThemeFrom("helix"), "helix");
  assert.equal(skyThemeFrom(null), "stellar");
  assert.equal(skyThemeFrom("deepsea"), "stellar", "a look that is no longer there");
  assert.equal(skyThemeFrom("solar"), "galaxy", "the solar system became the galaxy");
  assert.equal(skyThemeFrom("toString"), "stellar");
  assert.equal(colourFrom("#00FF00"), "#00ff00");
  assert.equal(colourFrom("red"), BRAIN_COLOUR);
  assert.equal(colourFrom(null), BRAIN_COLOUR);
});

/** Who links with whom, by index, both ways. */
const adjacency = (n: number, pairs: [number, number][]) => {
  const near: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) near[a].push(b), near[b].push(a);
  return near;
};

test("the galaxy's rings are how many links away from its core a note is, and what no link reaches is the halo", () => {
  // 0 - 1 - 2 - 3, 0 - 4, and 5 - 6 on their own; 7 is filtered out.
  const near = adjacency(8, [[0, 1], [1, 2], [2, 3], [0, 4], [5, 6]]);
  const shown = [true, true, true, true, true, true, true, false];
  assert.deepEqual([...ringsFrom(0, near, shown)], [0, 1, 2, 3, 1, 4, 4, -1]);
  // Another sun, other rings.
  assert.deepEqual([...ringsFrom(3, near, shown)].slice(0, 5), [3, 2, 1, 0, 4]);
  // A hidden link is no way through: 2 hidden cuts 3 off.
  assert.equal(ringsFrom(0, near, [true, true, false, true, true, true, true, false])[3], 2, "one past the farthest ring");
});

test("the galaxy: the core in the middle, the rest out along the arms as far as they are links away, and the halo round it", () => {
  // Rings from the core 0; the last two are the halo no link reaches.
  const ring = Int32Array.from([0, 1, 1, 2, 3, 3, 3, 9, 9]);
  const arm = [0, 0, 1, 0, 0, 0, 1, 0, 1];
  const stars = galaxyStars(ring, 9, arm, 2);
  assert.deepEqual(galaxyStars(ring, 9, arm, 2), stars, "the same galaxy each time");
  assert.equal(stars[0].radius, 0, "the core stays in the middle");
  assert.ok(stars[1].radius < stars[3].radius && stars[3].radius < stars[4].radius, "further out the more links away");
  assert.ok(stars.slice(1, 7).every((st) => !st.halo && Math.abs(st.height) < 0.05), "a thin disc");
  assert.ok(stars.slice(7).every((st) => st.halo && st.radius > Math.max(...stars.slice(1, 7).map((x) => x.radius))), "the halo round it");
  // On an arm: the angle winds on with the radius; the other arm is half a turn round.
  const along = (st: { angle: number; radius: number }, a: number) => ((st.angle - a * Math.PI - st.radius * WINDING) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  for (const i of [1, 2, 3, 4, 5, 6]) assert.ok(Math.abs(along(stars[i], arm[i])) < 0.2, `note ${i} on its arm`);
  // One ring and arm make a cluster: closer to each other than to the same ring on the other arm.
  const xy = (st: { radius: number; angle: number }) => [st.radius * Math.cos(st.angle), st.radius * Math.sin(st.angle)];
  const apart = (a: number, b: number) => Math.hypot(xy(stars[a])[0] - xy(stars[b])[0], xy(stars[a])[1] - xy(stars[b])[1]);
  assert.ok(apart(4, 5) < apart(4, 6) / 2, `${apart(4, 5)} ${apart(4, 6)}`);
  // The disc turns as one, so the arms keep their shape.
  assert.ok(stars.slice(1, 7).every((st) => st.speed === GALAXY_TURN));
  const chain = galaxyStars(Int32Array.from({ length: 80 }, (_, i) => i), -1, Array(80).fill(0), 2);
  assert.ok(Math.max(...chain.map((st) => st.radius)) < 1.05, "a long chain of links does not run off into space");
});

test("along the helix linked notes sit near each other, two to a turn, the strands opposite", () => {
  // A chain shuffled, 3-0-4-1-2, and 5 on its own.
  const near = adjacency(6, [[3, 0], [0, 4], [4, 1], [1, 2]]);
  const order = helixOrder(near, [true, true, true, true, true, true], [1, 2, 1, 1, 2, 0]);
  assert.equal(order.length, 6);
  assert.equal(order[0], 1, "from the most linked");
  // Each note after the first of its group follows the links from one already on the strand.
  for (let k = 1; k < 5; k++) assert.ok(order.slice(0, k).some((j) => near[j].includes(order[k])), `${order[k]}`);
  assert.equal(order[5], 5, "what links to nothing comes last");
  assert.deepEqual(helixOrder(near, [true, false, true, true, true, true], [1, 2, 1, 1, 2, 0]).includes(1), false, "a hidden note is not on it");
  const a = helixAt(0, 4, 0.1, 0.5, 0, 1);
  const b = helixAt(1, 4, 0.1, 0.5, 0, 1);
  assert.ok(Math.abs(a[1] - b[1]) < 1e-9, "a pair at one height");
  assert.ok(Math.abs(a[0] + b[0]) < 1e-9 && Math.abs(a[2] + b[2]) < 1e-9, "on opposite strands");
  assert.ok(Math.abs(helixAt(2, 4, 0.1, 0.5, 0, 1)[1] - a[1] - 0.1) < 1e-9, "the next pair a step along");
  assert.ok(Math.abs(helixAt(0, 4, 0.1, 0.5, 0, 1)[1] + helixAt(3, 4, 0.1, 0.5, 0, 1)[1]) < 1e-9, "centred");
});

test("the brain's lobes: each type its own, spread apart, and notes without one in the middle", () => {
  const types = ["A", "B", "C"];
  const where = types.map((ty) => lobeOf(ty, types));
  assert.equal(new Set(where.map(String)).size, 3);
  for (const p of where) for (const q of where) if (p !== q) assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 0.3);
  assert.deepEqual(lobeOf(undefined, types), [0, -0.05, 0]);
  assert.ok(LOBES.includes(lobeOf("Z", Array.from({ length: 20 }, (_, i) => (i === 15 ? "Z" : `t${i}`)))));
});

test("the gestures: a heart, a turn round a point, and a shake", () => {
  const [x0, y0] = heart(0);
  assert.ok(Math.abs(x0) < 1e-9 && y0 < 0, "the dip at the top");
  assert.ok(heart(0.5)[1] > 0.5, "the point at the bottom");
  assert.ok(Math.abs(heart(0.25)[0] + heart(0.75)[0]) < 1e-9, "the two halves mirror each other");
  // Round a point in steps: a whole turn adds up to 2π, back and forth adds up to nothing.
  const c = { x: 0, y: 0 };
  const round = Array.from({ length: 13 }, (_, k) => ({ x: Math.cos((k / 12) * Math.PI * 2), y: Math.sin((k / 12) * Math.PI * 2) }));
  const total = round.slice(1).reduce((sum, p, k) => sum + turnAround(round[k], p, c), 0);
  assert.ok(Math.abs(Math.abs(total) - Math.PI * 2) < 1e-9);
  assert.ok(Math.abs(turnAround({ x: 1, y: 0 }, { x: 0, y: 1 }, c) + turnAround({ x: 0, y: 1 }, { x: 1, y: 0 }, c)) < 1e-9);
  const shake = new Shake(1200, 12);
  let turns = 0;
  [0, 100, 0, 100, 0, 100].forEach((x, k) => (turns = shake.add(x, k * 50)));
  assert.equal(turns, 4);
  // Slow, the turns age out of the window; small moves are not turns at all.
  const slow = new Shake(1200, 12);
  [0, 100, 0, 100, 0, 100].forEach((x, k) => (turns = slow.add(x, k * 1000)));
  assert.ok(turns <= 2, `${turns}`);
  const small = new Shake(1200, 12);
  [0, 5, 0, 5, 0, 5].forEach((x, k) => (turns = small.add(x, k * 50)));
  assert.equal(turns, 0);
});
