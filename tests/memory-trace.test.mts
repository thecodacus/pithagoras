import { test } from "node:test";
import assert from "node:assert/strict";
import { noteOf, notesOf, stepsOf } from "../web/src/memory-trace.ts";

const paths = ["/deployment/branches.md", "/people/owner.md", "/people/index-of-people.md", "/a/same.md", "/b/same.md"];

test("a name in a step stands for the note it ends the way a path does, and for none when it could be two", () => {
  assert.equal(noteOf("/deployment/branches.md", paths), "/deployment/branches.md", "the full path");
  assert.equal(noteOf("deployment/branches.md", paths), "/deployment/branches.md", "from a folder");
  assert.equal(noteOf("branches.md", paths), "/deployment/branches.md", "the file's name, which only one note has");
  assert.equal(noteOf("../people/owner.md", paths), "/people/owner.md", "a relative path");
  assert.equal(noteOf("./owner.md", paths), "/people/owner.md");
  assert.equal(noteOf("same.md", paths), undefined, "two notes have this name: not guessed");
  assert.equal(noteOf("/a/same.md", paths), "/a/same.md");
  assert.equal(noteOf("gone.md", paths), undefined);
  assert.equal(noteOf("owner.md.bak", paths), undefined);
});

test("a notation is cut into its steps, each with what it did, to what, and which note that is", () => {
  const steps = stepsOf("browse layout → read branches.md → write people/owner.md → ✓", paths);
  assert.deepEqual(
    steps.map((s) => [s.verb, s.target, s.notes, s.end]),
    [
      ["browse", "layout", [], undefined],
      ["read", "branches.md", ["/deployment/branches.md"], undefined],
      ["write", "people/owner.md", ["/people/owner.md"], undefined],
      ["✓", "", [], "ok"],
    ],
  );
  // The ways a run says it ended, and an arrow written in ASCII.
  assert.equal(stepsOf("read branches.md -> ✗", paths)[1].end, "failed");
  assert.equal(stepsOf("read branches.md -> ✗", paths).length, 2);
  // A name in quotes or in a sentence is found, and the steps may name a note in a line that says more.
  assert.deepEqual(stepsOf('open "branches.md", then', paths)[0].notes, ["/deployment/branches.md"]);
});

test("a run with no notation, or a notation naming nothing of the graph, touches no notes", () => {
  assert.deepEqual(stepsOf(undefined, paths), []);
  assert.deepEqual(stepsOf("   ", paths), []);
  assert.deepEqual(notesOf(stepsOf("browse layout → ✓", paths)), []);
  assert.deepEqual(notesOf(stepsOf("read same.md → ✓", paths)), [], "ambiguous names are left out");
});

test("the notes a run touched come in the order it came to them, each once", () => {
  assert.deepEqual(notesOf(stepsOf("read owner.md → read branches.md → write owner.md → ✓", paths)), ["/people/owner.md", "/deployment/branches.md"]);
});
