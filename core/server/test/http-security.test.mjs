import { test } from "node:test";
import assert from "node:assert/strict";
import { portalSecurityHeaders } from "../dist/http-security.js";

/** The headers the portal's pages are sent with, as a response would hold them. */
function headers() {
  const set = new Map();
  let called = false;
  portalSecurityHeaders({}, { setHeader: (name, value) => set.set(name.toLowerCase(), value) }, () => { called = true; });
  assert.ok(called);
  return set;
}

test("the portal loads pictures only from itself, so one named by a reply sends nothing anywhere", () => {
  const policy = Object.fromEntries(headers().get("content-security-policy").split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
  assert.deepEqual(policy["img-src"], ["'self'", "data:", "blob:"]);
});
