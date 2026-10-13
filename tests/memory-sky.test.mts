import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAIN_COLOUR, brainOutline, colourFrom, intoBrain, layout3d, layout3dKept, pick, project, RESTING, seeded, skyThemeFrom } from "../web/src/memory-sky.ts";

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
  assert.equal(skyThemeFrom(null), "stellar");
  assert.equal(skyThemeFrom("toString"), "stellar");
  assert.equal(colourFrom("#00FF00"), "#00ff00");
  assert.equal(colourFrom("red"), BRAIN_COLOUR);
  assert.equal(colourFrom(null), BRAIN_COLOUR);
});
