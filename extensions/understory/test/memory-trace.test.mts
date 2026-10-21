import { test } from "node:test";
import assert from "node:assert/strict";
import { pathOf } from "../src/web/memory-trace.ts";
import type { MemoryTraceStep } from "../src/web/api.ts";

/** The notes of a graph, by their full paths: two share a file name, one has a space in it. */
const graph = new Set(["/deployment/branches.md", "/people/owner.md", "/projects/a/setup.md", "/projects/b/setup.md", "/x/my owner.md"]);
const step = (tool: string, paths: string[] = [], write = false, summary = paths[0] ?? ""): MemoryTraceStep => ({ seq: 1, tool, summary, paths, write });
/** A run whose steps are known, as Understory's /api/trace gives them. */
const run = (steps: MemoryTraceStep[], outcome = "success") => ({ steps, outcome });

test("a run whose steps have not come is its notation cut at Understory's own joint, words only", () => {
  const before = pathOf({ kind: "query", notation: 'search "owner" (2) → read owner.md → ✓' }, undefined, graph);
  assert.deepEqual(
    before.steps.map((s) => [s.verb, s.target, s.end]),
    [
      ["search", '"owner" (2)', undefined],
      ["read", "owner.md", undefined],
      ["✓", "", "ok"],
    ],
  );
  assert.equal(before.known, false);
  assert.deepEqual(before.notes, [], "nothing is said of its notes yet");
  // The three ways Understory ends a run.
  assert.equal(pathOf({ kind: "query", notation: "browse layout → ⚠ partial" }, undefined, graph).steps.at(-1)!.end, "partial");
  assert.equal(pathOf({ kind: "query", notation: "browse layout → ✗" }, undefined, graph).steps.at(-1)!.end, "failed");
  assert.deepEqual(pathOf({ kind: "query" }, undefined, graph).steps, []);
  assert.deepEqual(pathOf({ kind: "query", notation: "  " }, undefined, graph).steps, []);
  // An arrow without the spaces Understory puts round its own is part of a step's words.
  assert.deepEqual(pathOf({ kind: "query", notation: 'search "a->b" (0) → ✓' }, undefined, graph).steps.map((s) => s.text), ['search "a->b" (0)', "✓"]);
});

test("once its steps are known the words are made from them: a query with an arrow in it is one step, and the run is known", () => {
  // Understory writes the query as it was asked, so the notation of this run has two joints too many.
  const arrows = pathOf(
    { kind: "query", notation: 'search "deploy -> prod → stage" (1) → read branches.md → ✓' },
    run([step("search_knowledge", ["/deployment/branches.md"], false, "deploy -> prod → stage"), step("read_concept", ["/deployment/branches.md"])]),
    graph,
  );
  assert.deepEqual(arrows.steps.map((s) => s.text), ['search "deploy -> prod → stage" (1)', "read branches.md", "✓"]);
  assert.ok(arrows.known);
  assert.deepEqual(arrows.notes, ["/deployment/branches.md"], "and the note it read is lit");
  // A long query is cut where Understory cuts it, to thirty letters.
  const long = pathOf({ kind: "query" }, run([step("search_knowledge", [], false, "How is the deployment of the test host done?")]), graph);
  assert.equal(long.steps[0].text, 'search "How is the deployment of the …" (0)');
});

test("each tool is told as Understory's notation tells it, and how the run ended is its outcome", () => {
  const all = pathOf(
    { kind: "mutation" },
    run(
      [
        step("search_knowledge", ["/people/owner.md", "/deployment/branches.md"], false, "owner"),
        step("list_directory", [], false, ""),
        step("lint_knowledge", [], false, ""),
        step("read_concept", ["/people/owner.md"]),
        step("write_concept", ["/deployment/branches.md"], true),
        step("patch_concept", ["/people/owner.md"], true),
        step("delete_concept", ["/gone.md"], true),
        step("something_new", [], false, "x"),
      ],
      "partial",
    ),
    graph,
  );
  assert.deepEqual(all.steps.map((s) => s.text), ['search "owner" (2)', "browse layout", "lint graph", "read owner.md", "write branches.md", "patch owner.md", "delete gone.md", "something_new", "⚠ partial"]);
  assert.equal(all.steps.at(-1)!.end, "partial");
  assert.equal(pathOf({ kind: "query" }, run([step("list_directory")], "failed"), graph).steps.at(-1)!.end, "failed");
  assert.equal(pathOf({ kind: "query" }, run([step("list_directory")], "success"), graph).steps.at(-1)!.end, "ok");
  // A run with no outcome in it is ended as its notation ended it.
  assert.equal(pathOf({ kind: "query", notation: "browse layout → ✓" }, { steps: [step("list_directory")] }, graph).steps.at(-1)!.end, "ok");
});

test("the notes a run touched are the full paths its own steps give, not what its words say", () => {
  // Understory writes the file name only: `read setup.md` is one of two notes, and its own step says which.
  const one = pathOf({ kind: "query" }, run([step("search_knowledge", ["/projects/a/setup.md", "/projects/b/setup.md"], false, "setup"), step("read_concept", ["/projects/a/setup.md"])]), graph);
  assert.deepEqual(one.notes, ["/projects/a/setup.md"]);
  assert.deepEqual(one.steps.map((s) => s.notes), [[], ["/projects/a/setup.md"], []], "a search found notes and touched none");
  assert.equal(one.touched, 1);
  // A name with a space, and a search that names a file in its query.
  assert.deepEqual(pathOf({ kind: "query" }, run([step("read_concept", ["/x/my owner.md"])]), graph).notes, ["/x/my owner.md"]);
  const searched = pathOf({ kind: "query" }, run([step("search_knowledge", [], false, "branches.md"), step("list_directory")]), graph);
  assert.deepEqual(searched.notes, []);
  assert.equal(searched.touched, 0, "it touched no note at all");
  assert.ok(searched.known);
});

test("each tool that touches a note lights it, each once and in the order the run came to them", () => {
  const touched = pathOf(
    { kind: "mutation" },
    run([step("read_concept", ["/people/owner.md"]), step("write_concept", ["/deployment/branches.md"], true), step("patch_concept", ["/people/owner.md"], true), step("delete_concept", ["/gone.md"], true)]),
    graph,
  );
  assert.deepEqual(touched.notes, ["/people/owner.md", "/deployment/branches.md"]);
  assert.equal(touched.touched, 3, "three notes touched, and one of them is not in the graph any more");
});

test("a run changed the memory when a step wrote, whoever asked; before its steps are known, when it was a change asked for", () => {
  const wrote = run([step("search_knowledge"), step("write_concept", ["/deployment/branches.md"], true)]);
  assert.equal(pathOf({ kind: "chat" }, wrote, graph).changed, true, "the librarian wrote");
  assert.equal(pathOf({ kind: "mutation" }, run([step("search_knowledge")], "failed"), graph).changed, false, "it failed before it wrote");
  assert.equal(pathOf({ kind: "mutation", notation: "browse layout → ✓" }, undefined, graph).changed, true);
  assert.equal(pathOf({ kind: "query", notation: "browse layout → ✓" }, undefined, graph).changed, false);
});
