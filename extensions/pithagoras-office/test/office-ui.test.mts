/**
 * The browser half's pure helpers (src/office-ui.ts): where a page address says its opened document, and the
 * client-side mirror of the server's floating-image-tag refusal. Plain node: no portal, no DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { editorsIn, floatingTag, parseDocQuery } from "../src/office-ui";

test("parseDocQuery: ?doc=<id> is the opened document; encoded ids come back decoded", () => {
  assert.equal(parseDocQuery("?doc=my-report"), "my-report");
  assert.equal(parseDocQuery("?doc=report%20one&x=1"), "report one");
  assert.equal(parseDocQuery("/office?doc=a-b-c_123"), "a-b-c_123");
});

test("parseDocQuery: no doc, an empty one, or other parameters mean the list view", () => {
  assert.equal(parseDocQuery(""), null);
  assert.equal(parseDocQuery("?folder=9&doc="), null);
  assert.equal(parseDocQuery("?x=1"), null);
});

test("floatingTag: the server's :latest/:stable/@latest refusal, mirrored in the input", () => {
  assert.equal(floatingTag("onlyoffice/documentserver:latest"), true);
  assert.equal(floatingTag("onlyoffice/documentserver:LATEST"), true);
  assert.equal(floatingTag("onlyoffice/documentserver:stable"), true);
  assert.equal(floatingTag("registry.example/onlyoffice@latest"), true);
  assert.equal(floatingTag("onlyoffice/documentserver:10.0"), false);
  assert.equal(floatingTag("onlyoffice/documentserver"), false);
});

test("editorsIn: every doc has a locks entry (empty when nobody is in it); missing maps say none", () => {
  const locks = { a: [], b: [{ id: "u1", name: "n" }, { id: "u2" }] };
  assert.equal(editorsIn(locks, "a"), 0);
  assert.equal(editorsIn(locks, "b"), 2);
  assert.equal(editorsIn(undefined, "a"), 0);
});
