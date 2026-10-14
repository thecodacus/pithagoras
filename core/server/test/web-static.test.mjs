import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { scratch } from "./server-harness.mjs";

// The built web app as the server sends it: compressed where the build left a
// copy and the browser takes it, and kept for a year where the name says what is
// in it.

const root = scratch("pithagoras-web-static-");
// Below a dot folder, as a build kept under `~/.pithagoras` is: Express takes a
// file with one in its path for hidden and answers 404, unless it is told the root.
const dist = path.join(root, ".pithagoras", "web", "dist");
// What a path that climbs out of the build can name: the folder above it, and the one above that.
const outside = path.join(dist, "..", "secret.txt");
const farther = path.join(dist, "..", "..", "secret.txt");
mkdirSync(path.join(dist, "assets"), { recursive: true });
mkdirSync(path.join(dist, "voice-assets"));
for (const secret of [outside, farther]) writeFileSync(secret, "not for the web");
writeFileSync(path.join(dist, ".hidden.js"), "export const secret = 1;\n".repeat(200));
const script = "export const answer = 42;\n".repeat(200);
const wasm = Buffer.alloc(20_000, 7);
writeFileSync(path.join(dist, "assets", "app-AbC123.js"), script);
writeFileSync(path.join(dist, "index.html"), `<!doctype html><title>app</title>${"<p>x</p>".repeat(300)}`);
writeFileSync(path.join(dist, "voice-assets", "model.wasm"), wasm);
writeFileSync(path.join(dist, "logo.png"), Buffer.alloc(3000, 1));
writeFileSync(path.join(dist, "small.js"), "x");

const precompress = fileURLToPath(new URL("../../web/scripts/precompress.mjs", import.meta.url));
execFileSync(process.execPath, [precompress, dist], { stdio: "pipe" });

const { default: express } = await import("express");
const { serveWeb } = await import("../dist/web-static.js");
const app = express();
serveWeb(app, dist);
const server = app.listen(0);
test.after(() => {
  server.close();
});

/** A request as a browser makes one: raw, so that nothing decompresses what it was sent. */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, path: url, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the build leaves a copy beside each file that gains from one, and none beside the rest", () => {
  for (const name of ["assets/app-AbC123.js", "index.html", "voice-assets/model.wasm"]) {
    assert.ok(existsSync(path.join(dist, name + ".br")), `${name}.br`);
    assert.ok(existsSync(path.join(dist, name + ".gz")), `${name}.gz`);
  }
  assert.ok(!existsSync(path.join(dist, "logo.png.br")), "a picture does not shrink");
  assert.ok(!existsSync(path.join(dist, "small.js.br")), "nor does a file too small to ask for twice");
});

test("a browser that takes brotli is sent the brotli copy, typed as the file it is a copy of", async () => {
  const res = await get("/assets/app-AbC123.js", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], "br");
  assert.match(res.headers["content-type"], /javascript/);
  assert.match(res.headers.vary, /Accept-Encoding/i);
  assert.equal(brotliDecompressSync(res.body).toString(), script);
  assert.ok(res.body.length < script.length / 5);
});

test("one that takes only gzip is sent that, and a refused encoding is not sent whatever is accepted next to it", async () => {
  const gz = await get("/assets/app-AbC123.js", { "accept-encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gz.body).toString(), script);
  const refused = await get("/assets/app-AbC123.js", { "accept-encoding": "br;q=0, gzip" });
  assert.equal(refused.headers["content-encoding"], "gzip");
});

test("one that takes neither is sent the file itself, and the same address still says it varies", async () => {
  for (const headers of [{}, { "accept-encoding": "identity" }, { "accept-encoding": "br;q=0, gzip;q=0" }]) {
    const res = await get("/assets/app-AbC123.js", headers);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-encoding"], undefined);
    assert.equal(res.body.toString(), script);
    assert.match(res.headers.vary ?? "", /Accept-Encoding/i);
  }
});

test("what is named by its content is kept for a year, and the page and the models are asked again", async () => {
  for (const headers of [{ "accept-encoding": "br" }, {}]) {
    const res = await get("/assets/app-AbC123.js", headers);
    assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  }
  const page = await get("/index.html", { "accept-encoding": "br" });
  assert.equal(page.headers["cache-control"], "public, max-age=0");
  assert.equal(page.headers["content-encoding"], "br");
  const root = await get("/", { "accept-encoding": "br" });
  assert.equal(root.headers["content-encoding"], "br");
  assert.match(brotliDecompressSync(root.body).toString(), /<title>app<\/title>/);
  const model = await get("/voice-assets/model.wasm", { "accept-encoding": "br" });
  assert.equal(model.headers["content-type"], "application/wasm");
  assert.equal(model.headers["content-encoding"], "br");
  assert.equal(model.headers["cache-control"], "public, max-age=0");
  assert.deepEqual(brotliDecompressSync(model.body), wasm);
  // Without a copy it is sent as it is, and cached for as long as the rest of its kind.
  const png = await get("/logo.png", { "accept-encoding": "br" });
  assert.equal(png.headers["content-encoding"], undefined);
  assert.equal(png.body.length, 3000);
});

test("a copy is revalidated like the file, and is not served in ranges", async () => {
  const first = await get("/assets/app-AbC123.js", { "accept-encoding": "br" });
  const again = await get("/assets/app-AbC123.js", { "accept-encoding": "br", "if-none-match": first.headers.etag });
  assert.equal(again.status, 304);
  const part = await get("/assets/app-AbC123.js", { "accept-encoding": "br", range: "bytes=0-9" });
  assert.equal(part.status, 200);
  assert.equal(part.body.length, first.body.length);
});

test("a file written over since its copy was made is sent as it is now", async () => {
  const file = path.join(dist, "assets", "app-AbC123.js");
  const changed = "export const answer = 43;\n".repeat(200);
  writeFileSync(file, changed);
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  const res = await get("/assets/app-AbC123.js", { "accept-encoding": "br" });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString(), changed);
});

test("nothing outside the built files is reached by a path that climbs out of them", async () => {
  for (const secret of [outside, farther]) writeFileSync(secret + ".br", "x".repeat(2000));
  // Each URL is for a file that is there: a path that leads nowhere is a test of nothing, as it was
  // once the build moved deeper, and any server answered it with a 404.
  const climbing = {
    "/assets/..%2f..%2fsecret.txt": outside,
    "/..%2fsecret.txt": outside,
    "/%2e%2e/secret.txt": outside,
    "/..%2f..%2fsecret.txt": farther,
    "/assets/..%2f..%2f..%2fsecret.txt": farther,
    "/%2e%2e/%2e%2e/secret.txt": farther,
  };
  for (const [url, secret] of Object.entries(climbing)) {
    assert.equal(path.join(dist, decodeURIComponent(url)), secret, `${url} names the file it is about`);
    const res = await get(url, { "accept-encoding": "br" });
    assert.notEqual(res.body.toString(), "x".repeat(2000), url);
    assert.ok(!res.body.toString().includes("not for the web"), url);
  }
  const res = await get("/assets/%00", { "accept-encoding": "br" });
  assert.ok(!res.body.toString().includes("not for the web"));
});

test("a build below a dot folder is served, and a hidden file inside it still is not", async () => {
  // The compressed copy is the proof: sent as a copy, not as the plain file a failed copy falls back to.
  const res = await get("/voice-assets/model.wasm", { "accept-encoding": "br" });
  assert.equal(res.headers["content-encoding"], "br");
  const hidden = await get("/.hidden.js", { "accept-encoding": "br" });
  const body = hidden.headers["content-encoding"] === "br" ? brotliDecompressSync(hidden.body) : hidden.body;
  assert.ok(!body.toString().includes("secret"));
});

test("an address that is no file is the page, and a built file that is gone is not", async () => {
  const route = await get("/sessions/abc");
  assert.equal(route.status, 200);
  assert.match(route.body.toString(), /<title>app<\/title>/);
  assert.equal((await get("/assets/removed-Zz9.js")).status, 404);
  assert.equal((await get("/api/nothing")).status, 404);
});
