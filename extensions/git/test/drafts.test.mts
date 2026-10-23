import { test } from "node:test";
import assert from "node:assert/strict";
import type { Portal } from "@pithagoras/extension-api";
import { setPortal } from "../src/portal.tsx";
import { gitDrafts } from "../src/helpers.ts";

// The tab's session storage, as the portal hands it to an extension.
const stored = new Map<string, string>();
setPortal({
  ui: { storage: { session: { get: (key: string) => stored.get(key) ?? null, set: (key: string, value: string) => void stored.set(key, value), remove: (key: string) => void stored.delete(key) } } },
} as unknown as Portal);

// Before Git was an extension, the portal's own Git panel kept what was typed in it under these names
// (web/src/drafts.ts and web/src/components/git in v0.1.0): a tab left open across the upgrade keeps them.
test("a commit message or a pull request's text that the portal's own Git panel kept in the tab is there in the extension's", () => {
  stored.set("pithagoras.git-draft.s1:commit", "Fix the login");
  stored.set("pithagoras.git-draft.s1:pull-request:main", "What this changes");
  assert.equal(gitDrafts.get("s1:commit"), "Fix the login");
  assert.equal(gitDrafts.get("s1:pull-request:main"), "What this changes");

  gitDrafts.set("s1:commit", "Fix the login, and the logout");
  assert.equal(stored.get("pithagoras.git-draft.s1:commit"), "Fix the login, and the logout", "kept under the same name");
  gitDrafts.set("s1:commit", "");
  assert.equal(stored.has("pithagoras.git-draft.s1:commit"), false, "emptied, it is forgotten");
  assert.equal(gitDrafts.get("s1:commit"), "");
});
