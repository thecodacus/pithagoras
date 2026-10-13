import { test } from "node:test";
import assert from "node:assert/strict";
import { pathOf } from "../web/src/memory-trace.ts";
import type { MemoryTraceStep } from "../web/src/api.ts";

/** The notes of a graph, by their full paths: two share a file name, one has a space in it. */
const graph = new Set(["/deployment/branches.md", "/people/owner.md", "/projects/a/setup.md", "/projects/b/setup.md", "/x/my owner.md"]);
const step = (tool: string, paths: string[] = [], write = false, seq = 1): MemoryTraceStep => ({ seq, tool, summary: paths[0] ?? "", paths, write });

test("a run is its notation cut into steps, each with what it did and to what, and how it ended last", () => {
  const run = pathOf({ kind: "query", notation: 'search "owner" (2) → read owner.md → ✓' }, undefined, graph);
  assert.deepEqual(
    run.steps.map((s) => [s.verb, s.target, s.end]),
    [
      ["search", '"owner" (2)', undefined],
      ["read", "owner.md", undefined],
      ["✓", "", "ok"],
    ],
  );
  // The three ways Understory ends a run.
  assert.equal(pathOf({ kind: "query", notation: "browse layout → ⚠ partial" }, undefined, graph).steps.at(-1)!.end, "partial");
  assert.equal(pathOf({ kind: "query", notation: "browse layout → ✗" }, undefined, graph).steps.at(-1)!.end, "failed");
  assert.deepEqual(pathOf({ kind: "query" }, undefined, graph).steps, []);
  assert.deepEqual(pathOf({ kind: "query", notation: "  " }, undefined, graph).steps, []);
});

test("the notes a run touched are the full paths its own steps give, not what its words say", () => {
  // Understory writes the file name only: `read setup.md` is one of two notes, and its own step says which.
  const run = pathOf(
    { kind: "query", notation: 'search "setup" (2) → read setup.md → ✓' },
    [step("search_knowledge", ["/projects/a/setup.md", "/projects/b/setup.md"]), step("read_concept", ["/projects/a/setup.md"])],
    graph,
  );
  assert.deepEqual(run.notes, ["/projects/a/setup.md"]);
  assert.deepEqual(run.steps.map((s) => s.notes), [[], ["/projects/a/setup.md"], []], "a search found notes and touched none");
  assert.ok(run.known);
  assert.equal(run.touched, 1);
  // A name with a space in it, and a search that names a file in its query.
  assert.deepEqual(pathOf({ kind: "query", notation: "read my owner.md → ✓" }, [step("read_concept", ["/x/my owner.md"])], graph).notes, ["/x/my owner.md"]);
  const searched = pathOf({ kind: "query", notation: 'search "branches.md" (0) → browse layout → ✓' }, [step("search_knowledge"), step("list_directory")], graph);
  assert.deepEqual(searched.notes, []);
  assert.equal(searched.touched, 0, "it touched no note at all");
  assert.ok(searched.known);
});

test("each tool that touches a note lights it, each once and in the order the run came to them", () => {
  const run = pathOf(
    { kind: "mutation", notation: "read owner.md → write branches.md → patch owner.md → delete gone.md → ✓" },
    [step("read_concept", ["/people/owner.md"]), step("write_concept", ["/deployment/branches.md"], true), step("patch_concept", ["/people/owner.md"], true), step("delete_concept", ["/gone.md"], true)],
    graph,
  );
  assert.deepEqual(run.notes, ["/people/owner.md", "/deployment/branches.md"]);
  assert.equal(run.touched, 3, "three notes touched, and one of them is not in the graph any more");
});

test("before a run's steps are known nothing is said of its notes, and a notation that does not add up is not guessed at", () => {
  const before = pathOf({ kind: "mutation", notation: "browse layout → write branches.md → ✓" }, undefined, graph);
  assert.equal(before.known, false);
  assert.deepEqual(before.notes, []);
  assert.equal(before.steps.length, 3, "the words are there all the same");
  // Two steps for three parts of the notation.
  const odd = pathOf({ kind: "query", notation: "browse layout → read owner.md → ✓" }, [step("read_concept", ["/people/owner.md"])], graph);
  assert.equal(odd.known, false);
  assert.deepEqual(odd.notes, []);
});

test("a run changed the memory when a step wrote, whoever asked; before its steps are known, when it was a change asked for", () => {
  const wrote = [step("search_knowledge"), step("write_concept", ["/deployment/branches.md"], true)];
  assert.equal(pathOf({ kind: "chat", notation: 'search "x" (0) → write branches.md → ✓' }, wrote, graph).changed, true, "the librarian wrote");
  assert.equal(pathOf({ kind: "mutation", notation: 'search "x" (0) → ✗' }, [step("search_knowledge")], graph).changed, false, "it failed before it wrote");
  assert.equal(pathOf({ kind: "mutation", notation: "browse layout → ✓" }, undefined, graph).changed, true);
  assert.equal(pathOf({ kind: "query", notation: "browse layout → ✓" }, undefined, graph).changed, false);
});
