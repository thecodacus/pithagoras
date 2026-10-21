import { test } from "node:test";
import assert from "node:assert/strict";
import { insidePath, linkNotes } from "../src/web/memory-links.ts";

test("a link inside the memory is read from the note it is in; a folder's is to its index", () => {
  assert.equal(insidePath("../people/owner.md", "/deployment/branches.md"), "/people/owner.md");
  assert.equal(insidePath("branches.md", "/deployment/index.md"), "/deployment/branches.md");
  assert.equal(insidePath("/people/owner.md", "/deployment/branches.md"), "/people/owner.md");
  assert.equal(insidePath("deployment/", "/index.md"), "/deployment/index.md");
  assert.equal(insidePath("my%20note.md", "/"), "/my note.md");
  assert.equal(insidePath("https://example.com", "/a.md"), undefined);
  assert.equal(insidePath("mailto:x@y", "/a.md"), undefined);
  assert.equal(insidePath("#part", "/a.md"), undefined);
});

test("links to notes are made links to the Memory page; others are left as they were", () => {
  assert.equal(
    linkNotes('See [the owner](../people/owner.md "who") and [docs](https://x.org) and [deployment](deployment/).', "/deployment/branches.md"),
    'See [the owner](/x/pithagoras-understory/memory?note=%2Fpeople%2Fowner.md "who") and [docs](https://x.org) and [deployment](/x/pithagoras-understory/memory?note=%2Fdeployment%2Fdeployment%2Findex.md).',
  );
});

test("a link with a % that is not an escape is taken as written, and breaks nothing", () => {
  assert.equal(insidePath("stats/100%.md", "/"), "/stats/100%.md");
  assert.equal(insidePath("a%zz.md", "/x/y.md"), "/x/a%zz.md");
  assert.match(linkNotes("[growth](stats/100%.md)", "/"), /\(\/x\/pithagoras-understory\/memory\?note=/);
});
