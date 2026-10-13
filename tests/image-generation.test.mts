import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { inProcessHome } from "./helpers.mts";

const temp = inProcessHome("pitha-images-");

const { getSetting, putSetting } = await import("../server/src/db.ts");
const gen = await import("../server/src/image-generation.ts");
const { GENERATED_PICTURE_MARK } = await import("../server/src/generated-picture.ts");
const { GenerateImageTool, takenByAnother } = await import("../server/src/pi/generate-image-tool.ts");
const { GENERATED_DIR } = await import("../server/src/image-gallery.ts");
const editing = await import("../server/src/image-editing.ts");
const { EditImageTool, editedName } = await import("../server/src/pi/edit-image-tool.ts");

// The first bytes of each kind a browser draws, padded: that is all the check reads.
const pad = (head: number[], to = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(to)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const GIF = pad([...Buffer.from("GIF89a")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const KEY = "sk-test-0123456789";

interface Seen { method?: string; url?: string; auth?: string; agent?: string; body?: any; type?: string; raw?: Buffer }
/** A fake image endpoint: `handler` answers, and every request it gets is kept. */
async function fake(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<{ origin: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const whole = Buffer.concat(chunks);
      const raw = whole.toString("utf8");
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const one: Seen = { method: req.method, url: req.url, auth: req.headers.authorization, agent: req.headers["user-agent"], body, type: req.headers["content-type"], raw: whole };
      seen.push(one);
      handler(req, res, one);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, server };
}
/** The parts of a multipart request as an endpoint reads them, in the order they were sent: the name of each, with its file name, its type and its bytes. */
function partList(seen: Seen): { name: string; filename?: string; type?: string; bytes: Buffer }[] {
  const boundary = /boundary=(.+)$/.exec(seen.type ?? "")?.[1];
  assert.ok(boundary, `a multipart form, not ${seen.type}`);
  const found: { name: string; filename?: string; type?: string; bytes: Buffer }[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let at = seen.raw!.indexOf(delimiter);
  while (at >= 0) {
    const next = seen.raw!.indexOf(delimiter, at + delimiter.length);
    if (next < 0) break;
    const part = seen.raw!.subarray(at + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    found.push({ name: /name="([^"]*)"/.exec(head)![1], filename: /filename="([^"]*)"/.exec(head)?.[1], type: /content-type: (.+)/i.exec(head)?.[1], bytes: part.subarray(split + 4) });
    at = next;
  }
  return found;
}
/** The same by field name, for the fields that are there once. */
function parts(seen: Seen): Record<string, { filename?: string; type?: string; bytes: Buffer }> {
  return Object.fromEntries(partList(seen).map(({ name, ...rest }) => [name, rest]));
}
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const b64 = (bytes: Buffer) => bytes.toString("base64");
const config = (baseUrl: string, more: Partial<ReturnType<typeof gen.imageGenerationConfig>> = {}) => ({
  enabled: true, baseUrl, model: "image-model", size: "", apiKey: KEY, editEnabled: false, editBaseUrl: "", editModel: "", editApiKey: "", editMultiple: false, editMaxSize: "", timeoutSeconds: 300, sdExtras: false, ...more,
});
/** What the page is told of a fresh install, with `more` changed. */
const fresh = (more: Record<string, unknown> = {}) => ({
  enabled: false, baseUrl: "", model: "", size: "", keySet: false, editEnabled: false, editBaseUrl: "", editModel: "", editMultiple: false, editMaxSize: "", timeoutSeconds: 300, sdExtras: false, editKeySet: false, ready: false, editReady: false, ...more,
});

test("a request is checked: the address is a base with no secret in it, the size a real one", () => {
  const parse = gen.parseImageGenerationPatch;
  assert.deepEqual(parse({ baseUrl: " https://images.example.com/v1/ ", model: " m ", size: "1024x1024", apiKey: " k ", enabled: true }), {
    baseUrl: "https://images.example.com/v1", model: "m", size: "1024x1024", apiKey: "k", enabled: true,
  });
  assert.deepEqual(parse({ baseUrl: "", size: "" }), { baseUrl: "", size: "" }, "emptied is the way back to nothing");
  for (const bad of ["ftp://x/v1", "not a url", "https://user:pass@host/v1", "https://host/v1?api_key=abc", "https://host/v1#x"]) {
    assert.equal(typeof parse({ baseUrl: bad }), "string", bad);
  }
  assert.equal(typeof parse({ size: "huge" }), "string");
  // A default size is one the Media page takes as well: each side from 64 to 8192, or auto.
  for (const bad of ["16x16", "99999x99999", "63x64", "1024x8193"]) assert.match(String(parse({ size: bad })), /each side from 64 to 8192/, bad);
  for (const good of ["auto", "64x64", "8192x8192", " 1024x768 "]) assert.equal((parse({ size: good }) as { size: string }).size, good.trim(), good);
  assert.equal((parse({ size: "  " }) as { size: string }).size, "", "emptied is the way back to none");
  assert.equal(typeof parse({ enabled: "yes" }), "string");
  assert.equal(typeof parse({ model: 5 }), "string");
});

test("the route is added to the address unless it is there", () => {
  assert.equal(gen.endpointUrl("https://h.example/v1").href, "https://h.example/v1/images/generations");
  assert.equal(gen.endpointUrl("https://h.example/v1/").href, "https://h.example/v1/images/generations");
  assert.equal(gen.endpointUrl("https://h.example/v1/images/generations").href, "https://h.example/v1/images/generations");
  assert.equal(gen.endpointUrl("http://localhost:8080").href, "http://localhost:8080/images/generations");
});

test("it is off until switched on with an address, and the key is kept but never shown", () => {
  assert.equal(gen.imageGenerationReady(), false);
  assert.deepEqual(gen.imageGenerationState(), fresh());
  assert.throws(() => gen.saveImageGeneration({ enabled: true }), /address/, "no address to ask: not on");
  assert.equal(gen.imageGenerationReady(), false);

  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", model: "m", apiKey: KEY });
  assert.equal(gen.imageGenerationReady(), false, "an address alone does not switch it on");
  gen.saveImageGeneration({ enabled: true });
  assert.equal(gen.imageGenerationReady(), true);
  const state = gen.imageGenerationState();
  assert.equal(state.keySet, true);
  assert.equal(state.ready, true, "the page is told whether pictures can be made, and does not work it out");
  assert.ok(!("apiKey" in state));
  assert.ok(!JSON.stringify(state).includes(KEY), "nothing the page is given holds the key");

  // Kept while the address stays the server's; taken away with another server's.
  gen.saveImageGeneration({ model: "other" });
  assert.equal(gen.imageGenerationConfig().apiKey, KEY);
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v2" });
  assert.equal(gen.imageGenerationConfig().apiKey, KEY, "the same host");
  gen.saveImageGeneration({ baseUrl: "https://elsewhere.example.org/v1" });
  assert.equal(gen.imageGenerationConfig().apiKey, "", "a key is one server's: another is not given it");
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", apiKey: "k2" });
  assert.equal(gen.imageGenerationConfig().apiKey, "k2");
  gen.saveImageGeneration({ apiKey: "" });
  assert.equal(gen.imageGenerationState().keySet, false);
  assert.throws(() => gen.saveImageGeneration({ baseUrl: "" }), /address/, "not while it is on");
  gen.saveImageGeneration({ enabled: false });
  assert.equal(gen.imageGenerationReady(), false);
});

test("a key saved before any address goes with the first address, and is dropped only for another server", () => {
  gen.saveImageGeneration({ enabled: false, baseUrl: "", model: "", size: "", apiKey: "" });
  // What the Images form sends on two saves: the key first, then the address with the key field left empty.
  gen.saveImageGeneration({ baseUrl: "", model: "", size: "", apiKey: KEY });
  assert.equal(gen.imageGenerationState().keySet, true);
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", model: "image-model", size: "" });
  assert.equal(gen.imageGenerationState().keySet, true, "given for no server before: it is this one's now");
  assert.equal(gen.imageGenerationConfig().apiKey, KEY);
  // Now it is a server's: another is not given it.
  gen.saveImageGeneration({ baseUrl: "https://elsewhere.example.org/v1", model: "image-model", size: "" });
  assert.equal(gen.imageGenerationState().keySet, false);
  gen.saveImageGeneration({ baseUrl: "", apiKey: "" });
});

test("a default size saved before sizes were limited, and outside the limits, is none", () => {
  const was = getSetting("image_generation");
  try {
    putSetting("image_generation", JSON.stringify({ baseUrl: "https://images.example.com/v1", size: "16x16" }));
    assert.equal(gen.imageGenerationConfig().size, "", "the gallery would refuse it for every picture asked without a size");
    putSetting("image_generation", JSON.stringify({ baseUrl: "https://images.example.com/v1", size: "1024x1024" }));
    assert.equal(gen.imageGenerationConfig().size, "1024x1024");
  } finally {
    putSetting("image_generation", was ?? "{}");
  }
});

test("a picture comes back as base64 and is asked for with the model, the prompt and the key", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    const got = await gen.generateImage(config(`${origin}/v1`, { size: "512x512" }), { prompt: "a red square" });
    assert.equal(got.ext, "png");
    assert.deepEqual(got.bytes, PNG);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/v1/images/generations");
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.deepEqual(seen[0].body, { model: "image-model", prompt: "a red square", n: 1, size: "512x512" });
    assert.ok(seen[0].agent, "a user agent is sent, as some endpoints sit behind a firewall that refuses a request with none");

    // What the agent asks for wins over the default; no model and no key send neither.
    await gen.generateImage(config(origin, { model: "", apiKey: "" }), { prompt: "p", size: "1024x768" });
    assert.deepEqual(seen[1].body, { prompt: "p", n: 1, size: "1024x768" });
    assert.equal(seen[1].auth, undefined);
  } finally {
    server.close();
  }
});

test("only a PNG, JPEG, GIF or WebP counts, by its bytes, whatever it is called", async () => {
  let next = PNG;
  const { origin, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(next) }] }));
  try {
    for (const [bytes, ext] of [[PNG, "png"], [JPEG, "jpg"], [GIF, "gif"], [WEBP, "webp"]] as const) {
      next = bytes;
      assert.equal((await gen.generateImage(config(origin), { prompt: "p" })).ext, ext);
    }
    for (const bad of [SVG, Buffer.from("<html><script>alert(1)</script></html>"), Buffer.from("not a picture at all"), Buffer.alloc(0)]) {
      next = bad;
      await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), /not (base64|a PNG, JPEG, GIF or WebP picture)|no picture in it/);
    }
  } finally {
    server.close();
  }
});

test("a picture sent as a data URL is read, one that is not base64 is refused", async () => {
  let answer: unknown = { data: [{ url: `data:image/png;base64,${b64(PNG)}` }] };
  const { origin, server } = await fake((_req, res) => json(res, answer));
  try {
    assert.equal((await gen.generateImage(config(origin), { prompt: "p" })).ext, "png");
    answer = { data: [{ b64_json: b64(PNG).replace(/(.{16})/g, "$1\r\n") }] };
    assert.deepEqual((await gen.generateImage(config(origin), { prompt: "p" })).bytes, PNG, "wrapped lines are read as the other paths read them");
    answer = { data: [{ b64_json: "!!! not base64 !!!" }] };
    await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), /not base64/);
    for (const empty of [{ data: [] }, { data: [{}] }, {}, { data: "x" }]) {
      answer = empty;
      await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), /no picture in it/);
    }
  } finally {
    server.close();
  }
});

test("a picture sent as an address is fetched from the endpoint's own host, with the key", async () => {
  const { origin, seen, server } = await fake((req, res) => {
    if (req.url === "/files/a.png") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(JPEG);
    json(res, { data: [{ url: `${origin}/files/a.png` }] });
  });
  try {
    const got = await gen.generateImage(config(`${origin}/v1`), { prompt: "p" });
    assert.equal(got.ext, "jpg", "by its bytes, not the type it was served as");
    assert.equal(seen.at(-1)!.url, "/files/a.png");
    assert.equal(seen.at(-1)!.auth, `Bearer ${KEY}`, "the host the key was given for may have it back");
  } finally {
    server.close();
  }
});

test("an address on another host on this machine or its network is not fetched", async () => {
  const inner = await fake((_req, res) => res.writeHead(200).end(PNG));
  const { origin, server } = await fake((_req, res) => json(res, { data: [{ url: `${inner.origin}/secret.png` }] }));
  try {
    // Another port is another origin: a service of this machine the endpoint has no business pointing at.
    await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), /another host than the endpoint, and is only fetched from there over https/);
    assert.equal(inner.seen.length, 0, "nothing was asked of it");
  } finally {
    server.close();
    inner.server.close();
  }
});

test("a host given by name that leads to this machine is refused where the connection is made", async () => {
  // https, so the address itself passes; the name is only found out to be this machine's when it is looked up.
  const inner = await fake((_req, res) => res.writeHead(200).end(PNG));
  const { origin, server } = await fake((_req, res) => json(res, { data: [{ url: `https://localhost:${new URL(inner.origin).port}/secret.png` }] }));
  try {
    await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), /localhost, which is not on the public internet/);
    assert.equal(inner.seen.length, 0);
  } finally {
    server.close();
    inner.server.close();
  }
});

test("where an address may lead: its own origin, or the public internet over https", () => {
  const endpoint = new URL("http://gpu-box:8000/v1/images/generations");
  const refusal = (address: string) => gen.pictureUrlRefusal(new URL(address), endpoint);
  assert.equal(refusal("http://gpu-box:8000/out/1.png"), undefined, "the endpoint's own");
  assert.equal(refusal("https://cdn.example.com/1.png?sig=abc"), undefined, "a host by name: checked where it is connected to");
  assert.equal(refusal("https://93.184.216.34/1.png"), undefined, "a public address");
  assert.match(refusal("http://cdn.example.com/1.png")!, /over https/);
  assert.match(refusal("http://gpu-box:9000/1.png")!, /another host/);
  assert.match(refusal("https://169.254.169.254/latest/meta-data")!, /not on the public internet/);
  assert.match(refusal("https://127.0.0.1/1.png")!, /not on the public internet/);
  assert.match(refusal("https://10.0.0.5/1.png")!, /not on the public internet/);
  assert.match(refusal("https://[::1]/1.png")!, /not on the public internet/);
  assert.match(refusal("https://[::ffff:192.168.1.1]/1.png")!, /not on the public internet/);
  assert.match(refusal("https://2130706433/1.png")!, /not on the public internet/, "an address written as one number is still 127.0.0.1");
  assert.match(refusal("ftp://cdn.example.com/1.png")!, /not http or https/);
  assert.match(refusal("https://user:pw@cdn.example.com/1.png")!, /login/);
  assert.match(gen.pictureUrlRefusal(new URL("file:///etc/passwd"), endpoint)!, /not http or https/);
});

test("the key goes to the endpoint's own origin only, a picture's host elsewhere never has it", () => {
  const endpoint = new URL("https://images.example.com/v1/images/generations");
  assert.deepEqual(gen.downloadHeaders(new URL("https://images.example.com/files/1.png"), endpoint, KEY), { accept: "image/*", authorization: `Bearer ${KEY}` });
  assert.deepEqual(gen.downloadHeaders(new URL("https://cdn.example.net/1.png?sig=abc"), endpoint, KEY), { accept: "image/*" });
  assert.deepEqual(gen.downloadHeaders(new URL("https://images.example.com:8443/1.png"), endpoint, KEY), { accept: "image/*" }, "another port is another server");
  assert.deepEqual(gen.downloadHeaders(new URL("https://images.example.com/1.png"), endpoint, ""), { accept: "image/*" });
});

test("which addresses are public", () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(gen.isPublicAddress(address), true, address);
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "nope", "",
  ]) assert.equal(gen.isPublicAddress(address), false, address);
  assert.equal(gen.isPublicAddress("172.32.0.1"), true, "just past 172.16/12");
});

test("a redirect on the way to a picture is judged like the address itself", async () => {
  const inner = await fake((_req, res) => res.writeHead(200).end(PNG));
  let target = "/files/hop";
  const own = await fake((req, res) => {
    if (req.url === "/files/own.png") return res.writeHead(200).end(GIF);
    if (req.url === "/files/hop") return res.writeHead(302, { location: "/files/own.png" }).end();
    if (req.url === "/files/leave") return res.writeHead(302, { location: `${inner.origin}/secret.png` }).end();
    if (req.url === "/files/loop") return res.writeHead(302, { location: "/files/loop" }).end();
    json(res, { data: [{ url: `${own.origin}${target}` }] });
  });
  try {
    assert.equal((await gen.generateImage(config(own.origin), { prompt: "p" })).ext, "gif", "within its own host: followed");
    target = "/files/leave";
    await assert.rejects(gen.generateImage(config(own.origin), { prompt: "p" }), /another host/);
    assert.equal(inner.seen.length, 0, "the other place was never asked");
    target = "/files/loop";
    await assert.rejects(gen.generateImage(config(own.origin), { prompt: "p" }), /redirects too often/);
  } finally {
    own.server.close();
    inner.server.close();
  }
});

test("the endpoint itself is never followed elsewhere: the key stays with it", async () => {
  const inner = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  const { origin, server } = await fake((_req, res) => res.writeHead(307, { location: `${inner.origin}/v1/images/generations` }).end());
  try {
    await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), /answered with a redirect, which is not followed/);
    assert.equal(inner.seen.length, 0, "no request, and so no key, went there");
  } finally {
    server.close();
    inner.server.close();
  }
});

test("a picture over the limit is not taken, however it arrives", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(4096)]);
  let mode: "b64" | "length" | "stream" = "b64";
  const { origin, server } = await fake((req, res) => {
    if (req.url === "/big.png") {
      if (mode === "length") return res.writeHead(200, { "content-length": big.length }).end(big);
      // No length given: only counting what comes tells.
      res.writeHead(200);
      return void res.end(big);
    }
    json(res, { data: [mode === "b64" ? { b64_json: b64(big) } : { url: `${origin}/big.png` }] });
  });
  try {
    for (const m of ["b64", "length", "stream"] as const) {
      mode = m;
      await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }, { maxBytes: 1024 }), /over/, m);
    }
    assert.equal((await gen.generateImage(config(origin), { prompt: "p" }, { maxBytes: 1024 * 1024 })).ext, "png");
  } finally {
    server.close();
  }
});

test("a server that never answers is given up on, and a chat that is stopped stops it", async () => {
  const { origin, server } = await fake(() => {});
  try {
    await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }, { timeoutMs: 150 }), /did not answer within/);
    const stop = new AbortController();
    const slow = gen.generateImage(config(origin), { prompt: "p" }, { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    await assert.rejects(slow, (e: Error) => !(e instanceof gen.ImageGenerationError) && /abort/i.test(e.name));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("an error from the endpoint is passed on without the key, even where it repeats it", async () => {
  const { origin, server } = await fake((_req, res) => json(res, { error: { message: `Invalid key ${KEY} for model image-model` } }, 401));
  try {
    await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), (e: Error) => {
      assert.match(e.message, /answered 401: Invalid key \[key\] for model/);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  } finally {
    server.close();
  }
  const html = await fake((_req, res) => res.writeHead(502).end("<html>Bad gateway</html>"));
  try {
    await assert.rejects(gen.generateImage(config(html.origin), { prompt: "p" }), /answered 502/);
  } finally {
    html.server.close();
  }
  // Nothing listening: said, without the key.
  await assert.rejects(gen.generateImage(config("http://127.0.0.1:1"), { prompt: "p" }), (e: Error) => /Could not reach the image endpoint/.test(e.message) && !e.message.includes(KEY));
});

test("a key repeated across the cut of a long error message is scrubbed before the cut, not found by neither", async () => {
  // The key starts before character 300 of the message and ends after it, so cut first it would be found whole by no one.
  const message = `${"Rejected by the gateway after a long explanation. ".repeat(6).slice(0, 266)}Invalid API key: ${KEY} for model image-model`;
  assert.ok(message.indexOf(KEY) < 300 && message.indexOf(KEY) + KEY.length > 300, "the key straddles the cut");
  const { origin, server } = await fake((_req, res) => json(res, { error: { message } }, 401));
  try {
    await assert.rejects(gen.generateImage(config(origin), { prompt: "p" }), (e: Error) => {
      assert.match(e.message, /answered 401: Rejected by the gateway/);
      // Nothing of the key is left, not even its start.
      assert.ok(!e.message.includes(KEY.slice(0, 8)), e.message);
      assert.match(e.message, /Invalid API key: \[key\]/);
      return true;
    });
  } finally {
    server.close();
  }
});

/** The tool as pi gets it, and a way to call it. */
function load(folder: string) {
  const tool = new GenerateImageTool(folder);
  const registered: any[] = [];
  tool.extension({ registerTool: (t: any) => registered.push(t) });
  return { tool, registered, call: (p: any, signal?: AbortSignal) => registered[0].execute("id", p, signal) };
}

test("while it is off, or has no address, the tool is not there at all", () => {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  const off = load(folder);
  assert.deepEqual(off.registered, []);
  assert.equal(off.tool.registered(), false);

  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", enabled: true });
  const on = load(folder);
  assert.deepEqual(on.registered.map((t) => t.name), ["generate_image"]);
  assert.equal(on.tool.registered(), true);

  // Loaded again after a switch, as pi does on a reload: it follows.
  gen.saveImageGeneration({ enabled: false });
  on.tool.extension({ registerTool: () => assert.fail("not while it is off") });
  assert.equal(on.tool.registered(), false);
});

test("the tool makes a picture in the chat's folder and answers as show_image does", async () => {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    gen.saveImageGeneration({ baseUrl: origin, model: "image-model", apiKey: KEY, enabled: true });
    const { call, registered } = load(folder);
    const params = registered[0].parameters;
    assert.deepEqual(Object.keys(params.properties).sort(), ["prompt", "size", "title"]);
    assert.ok(!JSON.stringify(registered[0]).includes(KEY));

    const result = await call({ prompt: "  a lighthouse at dusk  ", title: "Lighthouse", size: "1024x1024" });
    assert.match(result.details.path, new RegExp(`^${GENERATED_DIR}/image-\\d{8}-\\d{6}-[0-9a-f]{6}\\.png$`));
    // The same details as show_image's, and the mark that tells this tool's answer from another extension's of the name.
    assert.deepEqual(result.details, { path: result.details.path, title: "Lighthouse", [GENERATED_PICTURE_MARK]: true });
    assert.ok(!path.isAbsolute(result.details.path), "a path in the chat's folder, which is what the page asks for");
    assert.match(result.content[0].text, /shown to the user/i);
    assert.deepEqual(readFileSync(path.join(folder, result.details.path)), PNG);
    assert.deepEqual(seen[0].body, { model: "image-model", prompt: "a lighthouse at dusk", n: 1, size: "1024x1024" });

    // Without a title, the prompt is the caption; a second one never takes the first's place.
    const again = await call({ prompt: "a lighthouse\nat   dusk" });
    assert.equal(again.details.title, "a lighthouse at dusk");
    assert.notEqual(again.details.path, result.details.path);
    assert.equal(readdirSync(path.join(folder, GENERATED_DIR)).length, 2);
    assert.deepEqual(readdirSync(folder), [GENERATED_DIR], "nothing else was made in the folder");
  } finally {
    server.close();
  }
});

test("the name is made by the portal: nothing the agent or the endpoint says reaches it", async () => {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  const { origin, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(JPEG), revised_prompt: "../../../escape", url: "../../x" }], created: "../../y" }));
  try {
    gen.saveImageGeneration({ baseUrl: origin, enabled: true });
    const { call } = load(folder);
    const result = await call({ prompt: "../../../etc/passwd", title: "../../x.png" });
    assert.match(result.details.path, /^generated-images\/image-[\d-]+-[0-9a-f]{6}\.jpg$/);
    assert.equal(existsSync(path.join(folder, "..", "escape")), false);
    assert.deepEqual(readdirSync(folder), [GENERATED_DIR]);
  } finally {
    server.close();
  }
});

test("a folder in the chat that leads out of it is not written through", async () => {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  const outside = mkdtempSync(path.join(temp, "outside-"));
  symlinkSync(outside, path.join(folder, GENERATED_DIR));
  const { origin, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    gen.saveImageGeneration({ baseUrl: origin, enabled: true });
    await assert.rejects(load(folder).call({ prompt: "p" }));
    assert.deepEqual(readdirSync(outside), [], "nothing outside the folder");
  } finally {
    server.close();
  }
});

test("the tool fails loudly: a bad ask, an endpoint with no picture, an add-on switched off since", async () => {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  let answer: unknown = { data: [{ b64_json: b64(PNG) }] };
  const { origin, server } = await fake((_req, res) => json(res, answer));
  try {
    gen.saveImageGeneration({ baseUrl: origin, enabled: true });
    const { call } = load(folder);
    await assert.rejects(call({ prompt: "   " }), /prompt is required/);
    await assert.rejects(call({ prompt: "x".repeat(4001) }), /over 4000 characters/);
    await assert.rejects(call({ prompt: "p", size: "huge" }), /1024x1024/);
    // The sides the gallery takes, no others: the agent cannot ask for what the page refuses.
    for (const size of ["99999x99999", "16x16", "1024x8193"]) await assert.rejects(call({ prompt: "p", size }), /each side from 64 to 8192/, size);
    answer = { data: [{ b64_json: b64(SVG) }] };
    await assert.rejects(call({ prompt: "p" }), /not a PNG, JPEG, GIF or WebP/);
    assert.equal(existsSync(path.join(folder, GENERATED_DIR)), false, "what is not a picture is not kept");
    // Changed since it was loaded: in force at once; switched off since: refused.
    server.closeAllConnections();
    gen.saveImageGeneration({ enabled: false });
    await assert.rejects(call({ prompt: "p" }), /switched off/);
  } finally {
    server.close();
  }
});

test("the API holds the settings, never gives the key back, and reloads chats only when the tool comes or goes", async () => {
  const express = (await import("express")).default;
  const { featuresRouter } = await import("../server/src/api/features.ts");
  const app = express().use(express.json()).use("/api", featuresRouter());
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${at}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    assert.ok(!text.includes(KEY), `${method} ${p} gave the key back`);
    return { status: r.status, body: JSON.parse(text) };
  };
  try {
    // As a fresh install has it, whatever the tests before left.
    gen.saveImageGeneration({ enabled: false, baseUrl: "", model: "", size: "", apiKey: "" });
    assert.deepEqual((await call("GET", "/features/images")).body, { images: fresh() });
    assert.equal((await call("PUT", "/features/images", { enabled: true })).status, 400, "nowhere to ask yet");
    assert.equal((await call("PUT", "/features/images", { baseUrl: "https://u:p@h.example/v1" })).status, 400);
    assert.equal((await call("PUT", "/features/images", { size: "wide" })).status, 400);

    const saved = await call("PUT", "/features/images", { baseUrl: "https://images.example.com/v1", model: "image-model", apiKey: KEY });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { images: fresh({ baseUrl: "https://images.example.com/v1", model: "image-model", keySet: true }), changed: false, reloaded: 0, waiting: 0 });
    const on = await call("PUT", "/features/images", { enabled: true });
    assert.equal(on.body.changed, true, "the tool is there from now on: chats are reloaded");
    assert.equal(on.body.images.enabled, true);
    assert.equal((await call("PUT", "/features/images", { model: "other" })).body.changed, false, "the model is read at each call: no reload");

    assert.equal((await call("GET", "/features/images")).body.images.keySet, true);
    assert.equal((await call("PUT", "/features/images", { apiKey: "" })).body.images.keySet, false);
    // The page's whole picture of the features has it too, and still no key.
    await call("PUT", "/features/images", { apiKey: KEY });
    const all = await call("GET", "/features");
    assert.equal(all.body.images.keySet, true);
    assert.ok(!("apiKey" in all.body.images));
    await call("PUT", "/features/images", { enabled: false });
  } finally {
    portal.close();
  }
});

test("the tool menus do not offer generate_image while the add-on is off, though it is remembered for when it is on", async () => {
  const { remembered, rememberTools, shownTools, knownTools } = await import("../server/src/db.ts");
  // As a chat that had the tool reports it: no package of the user's brings it, and pi names its extension <inline:…>.
  rememberTools([
    remembered({ name: "generate_image", source: "image-generation", inline: true }),
    remembered({ name: "show_image", source: "pictures", inline: true }),
  ]);
  const names = () => shownTools().map((t) => t.name).filter((n) => /image/.test(n));
  gen.saveImageGeneration({ enabled: false, baseUrl: "", apiKey: "" });
  assert.deepEqual(names(), ["show_image"]);
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1" });
  assert.deepEqual(names(), ["show_image"], "an address alone does not make the tool");
  gen.saveImageGeneration({ enabled: true });
  assert.deepEqual(names().sort(), ["generate_image", "show_image"]);
  gen.saveImageGeneration({ enabled: false });
  assert.deepEqual(names(), ["show_image"]);
  assert.equal(knownTools().find((t) => t.name === "generate_image")?.inline, true, "remembered for when it is on");
  assert.ok(!("package" in shownTools()[0]), "the page is not told how it is kept");
  assert.equal(shownTools()[0].inline, true, "only that it is the portal's own, for the lists to group it");

  // An extension's tool of the same name is loaded whatever the add-on says, so it is offered — also from a
  // file or a folder called image-generation, which has the same label the portal's extension has.
  for (const source of ["image-package", "image-generation"]) {
    rememberTools([remembered({ name: "generate_image", source })]);
    assert.deepEqual(names().sort(), ["generate_image", "show_image"], source);
    assert.equal(shownTools().find((t) => t.name === "generate_image")?.inline, undefined, `${source}: not the portal's own`);
    rememberTools([remembered({ name: "generate_image", source: "image-generation", package: "npm:image-package" })]);
    assert.deepEqual(names().sort(), ["generate_image", "show_image"], `${source}, from a package`);
  }
  // The portal's own again, as the next chat that has it reports it.
  rememberTools([remembered({ name: "generate_image", source: "image-generation", inline: true })]);
  assert.deepEqual(names(), ["show_image"]);
});

test("the portal's tool is not filed under an image package that was switched off to make way for it", async () => {
  const { remembered, rememberTools, shownTools, knownTools } = await import("../server/src/db.ts");
  const settings = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
  const names = () => shownTools().map((t) => t.name).filter((n) => n === "generate_image");
  try {
    mkdirSync(path.dirname(settings), { recursive: true });
    // A package of the user's with a tool of that name, as the docs say to switch it off for the add-on.
    writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-image-tools"] }));
    rememberTools([remembered({ name: "generate_image", source: "pi-image-tools", package: "npm:pi-image-tools" })]);
    gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", enabled: true });
    assert.deepEqual(names(), ["generate_image"]);

    // Switched off, as setPackageEnabled writes it: still listed, loading nothing. A chat now reports the portal's own.
    writeFileSync(settings, JSON.stringify({ packages: [{ source: "npm:pi-image-tools", extensions: [], skills: [], prompts: [], themes: [] }] }));
    rememberTools([remembered({ name: "generate_image", source: "image-generation", inline: true })]);
    assert.equal(knownTools().find((t) => t.name === "generate_image")?.package, null, "it comes from no package");
    assert.deepEqual(names(), ["generate_image"], "offered while the add-on is on");
    gen.saveImageGeneration({ enabled: false });
    assert.deepEqual(names(), [], "and not while it is off");
  } finally {
    rmSync(settings, { force: true });
    gen.saveImageGeneration({ enabled: false });
  }
});

test("an extension's tool of the same name is the one pi keeps, so the portal's is not counted as there", () => {
  const ext = (extensionPath: string, ...names: string[]) => ({ path: extensionPath, tools: new Map(names.map((n) => [n, { definition: { name: n } }])) });
  const own = ext("<inline:image-generation>", "generate_image");
  assert.equal(takenByAnother([]), false);
  assert.equal(takenByAnother([ext("/x/other.ts", "other_tool"), own]), false, "its own is not another's");
  assert.equal(takenByAnother([ext("/x/image-package.ts", "edit_image", "generate_image"), own]), true);

  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", enabled: true });
  let loaded: any[] = [own];
  const tool = new GenerateImageTool(mkdtempSync(path.join(temp, "chat-")), () => loaded);
  assert.equal(tool.registered(), false, "not before it is loaded");
  tool.extension({ registerTool: () => {} });
  assert.equal(tool.registered(), true);
  loaded = [ext("/x/image-package.ts", "generate_image"), own];
  assert.equal(tool.registered(), false, "an extension's tool is the model's");
  gen.saveImageGeneration({ enabled: false });
});

// --- editing a picture ---

/** As a fresh install has the settings, whatever the tests before left. */
const reset = () => gen.saveImageGeneration({
  enabled: false, editEnabled: false, baseUrl: "", model: "", size: "", apiKey: "", editBaseUrl: "", editModel: "", editApiKey: "", editMultiple: false, editMaxSize: "", timeoutSeconds: 300, sdExtras: false,
});

test("a request for editing is checked as one for generation is", () => {
  const parse = gen.parseImageGenerationPatch;
  assert.deepEqual(parse({ editEnabled: true, editBaseUrl: " https://edit.example.com/v1/ ", editModel: " m ", editApiKey: " k " }), {
    editEnabled: true, editBaseUrl: "https://edit.example.com/v1", editModel: "m", editApiKey: "k",
  });
  assert.deepEqual(parse({ editBaseUrl: "" }), { editBaseUrl: "" }, "emptied is the way back to the address of generation");
  for (const bad of ["ftp://x/v1", "not a url", "https://user:pass@host/v1", "https://host/v1?api_key=abc", "https://host/v1#x"]) {
    assert.equal(typeof parse({ editBaseUrl: bad }), "string", bad);
  }
  assert.equal(typeof parse({ editEnabled: "yes" }), "string");
  assert.equal(typeof parse({ editModel: 5 }), "string");
  assert.equal(typeof parse({ editModel: "m".repeat(201) }), "string");
  assert.equal(typeof parse({ editApiKey: 5 }), "string");
  assert.equal(typeof parse({ editApiKey: "k".repeat(4001) }), "string");
});

test("editing is off until it is switched on with an address, its own or generation's, and its key is never shown", () => {
  reset();
  assert.equal(gen.imageEditingReady(), false);
  assert.throws(() => gen.saveImageGeneration({ editEnabled: true }), /address/, "nowhere to ask: not on");
  assert.equal(gen.imageEditingReady(), false);

  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", apiKey: KEY });
  assert.equal(gen.imageEditingReady(), false, "an address alone does not switch it on");
  gen.saveImageGeneration({ editEnabled: true });
  assert.equal(gen.imageEditingReady(), true, "the address of generation will do");
  assert.equal(gen.imageGenerationReady(), false, "and is a switch of its own: generation is still off");
  assert.deepEqual(gen.imageGenerationState(), fresh({ baseUrl: "https://images.example.com/v1", keySet: true, editEnabled: true, editReady: true }));

  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v1", editModel: "edit-model", editApiKey: "edit-key" });
  const state = gen.imageGenerationState();
  assert.deepEqual(state, fresh({ baseUrl: "https://images.example.com/v1", keySet: true, editEnabled: true, editBaseUrl: "https://edit.example.net/v1", editModel: "edit-model", editKeySet: true, editReady: true }));
  assert.ok(!JSON.stringify(state).includes("edit-key") && !JSON.stringify(state).includes(KEY), "nothing the page is given holds a key");

  // Back to the address of generation; and no address at all is no editing, whatever the switch says.
  gen.saveImageGeneration({ editBaseUrl: "" });
  assert.equal(gen.imageEditingTarget().baseUrl, "https://images.example.com/v1");
  assert.throws(() => gen.saveImageGeneration({ baseUrl: "" }), /address/, "not while it is on");
  gen.saveImageGeneration({ editEnabled: false });
  assert.equal(gen.imageEditingReady(), false);
  reset();
});

test("a key goes only to the server it was given for: generation's never to another edit address", () => {
  reset();
  const target = gen.imageEditingTarget;
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", apiKey: KEY, editEnabled: true, editModel: "edit-model" });
  assert.deepEqual(target(), { baseUrl: "https://images.example.com/v1", model: "edit-model", apiKey: KEY, multiple: false, maxSize: "", timeoutSeconds: 300, sdExtras: false }, "edits to the generation server have its key");
  assert.equal(target().model, "edit-model", "and never the model of generation, which may only make pictures");

  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v1" });
  assert.equal(target().apiKey, "", "another server is not given the key of generation");
  gen.saveImageGeneration({ editBaseUrl: "https://images.example.com/v2" });
  assert.equal(target().apiKey, KEY, "the same server, by another route");
  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v1", editApiKey: "ek" });
  assert.equal(target().apiKey, "ek");
  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v2" });
  assert.equal(target().apiKey, "ek", "kept while the address stays the server's");
  gen.saveImageGeneration({ baseUrl: "https://elsewhere.example.org/v1" });
  assert.equal(target().apiKey, "ek", "the key of edits does not follow the address of generation while edits have one of their own");
  gen.saveImageGeneration({ editBaseUrl: "https://third.example.org/v1" });
  assert.equal(gen.imageGenerationState().editKeySet, false, "a new address of another server without a key has none");

  // Edits going where generation goes: the key given for them goes with the address, not with the switch.
  reset();
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true, editApiKey: "ek" });
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v2" });
  assert.equal(target().apiKey, "ek", "the same server");
  gen.saveImageGeneration({ baseUrl: "https://elsewhere.example.org/v1" });
  assert.equal(gen.imageGenerationState().editKeySet, false, "edits went to another server with it: the key was not given for that");
  assert.equal(target().apiKey, "");

  // A key saved before there was an address was given for none, and goes with the first.
  reset();
  gen.saveImageGeneration({ editApiKey: "ek" });
  assert.equal(gen.imageGenerationState().editKeySet, true);
  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v1" });
  assert.equal(target().apiKey, "ek");
  gen.saveImageGeneration({ editBaseUrl: "" });
  assert.equal(gen.imageGenerationState().editKeySet, false, "back at generation's server, which the key was not given for");
  reset();
});

test("the route for edits is added to the address unless it is there, and generation's is swapped for it", () => {
  assert.equal(editing.editEndpointUrl("https://h.example/v1").href, "https://h.example/v1/images/edits");
  assert.equal(editing.editEndpointUrl("https://h.example/v1/").href, "https://h.example/v1/images/edits");
  assert.equal(editing.editEndpointUrl("https://h.example/v1/images/edits").href, "https://h.example/v1/images/edits");
  assert.equal(editing.editEndpointUrl("https://h.example/v1/images/generations").href, "https://h.example/v1/images/edits", "the address saved for generation, used for edits");
  assert.equal(editing.editEndpointUrl("http://localhost:8080").href, "http://localhost:8080/images/edits");
});

const target = (baseUrl: string, more: Partial<ReturnType<typeof gen.imageEditingTarget>> = {}) => ({ baseUrl, model: "edit-model", apiKey: KEY, multiple: false, maxSize: "", timeoutSeconds: 300, sdExtras: false, ...more });

test("an edit is a form with the picture, the prompt and the model, sent with the key to this address", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(JPEG) }] }));
  try {
    const got = await editing.editImage(target(`${origin}/v1`), { prompt: "make it red", image: PNG });
    assert.equal(got.ext, "jpg", "the result is whatever its bytes say");
    assert.deepEqual(got.bytes, JPEG);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/v1/images/edits");
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.match(seen[0].type!, /^multipart\/form-data; boundary=/);
    const form = parts(seen[0]);
    assert.deepEqual(Object.keys(form).sort(), ["image", "model", "n", "prompt"], "no size and no mask unless given");
    assert.deepEqual(form.image.bytes, PNG);
    assert.equal(form.image.type, "image/png", "its type is its bytes'");
    assert.equal(form.image.filename, "image.png", "a neutral name, never the file's own");
    assert.equal(form.prompt.bytes.toString(), "make it red");
    assert.equal(form.model.bytes.toString(), "edit-model");
    assert.equal(form.n.bytes.toString(), "1");

    // A mask goes along as a file of its own; no model and no key send neither.
    await editing.editImage(target(origin, { model: "", apiKey: "" }), { prompt: "p", image: WEBP, mask: GIF });
    const withMask = parts(seen[1]);
    assert.deepEqual(Object.keys(withMask).sort(), ["image", "mask", "n", "prompt"]);
    assert.deepEqual(withMask.mask.bytes, GIF);
    assert.equal(withMask.mask.type, "image/gif");
    assert.equal(withMask.mask.filename, "mask.gif");
    assert.equal(withMask.image.type, "image/webp");
    assert.equal(seen[1].auth, undefined);
    assert.equal(seen[1].url, "/images/edits");
  } finally {
    server.close();
  }
});

test("an edit has the OpenAI fields as fields, and what only stable-diffusion.cpp reads in the prompt, which is left out while the switch for it is off", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  const ask = { prompt: "make it night", image: [PNG, WEBP], model: "page-model", size: "512x768", outputFormat: "webp" as const, outputCompression: 70, native: { fromNoise: true, seed: 9, negativePrompt: "blurry" } };
  try {
    await editing.editImage(target(origin, { multiple: true, sdExtras: true }), ask);
    const on = parts(seen[0]);
    assert.deepEqual(Object.keys(on).sort(), ["image[]", "model", "n", "output_compression", "output_format", "prompt", "size"].sort(), "a field of the format, or nothing: no seed, no strength, no init_image");
    assert.equal(on.model.bytes.toString(), "page-model", "the form's model, not the saved one");
    assert.equal(on.size.bytes.toString(), "512x768");
    assert.equal(on.output_format.bytes.toString(), "webp");
    assert.equal(on.output_compression.bytes.toString(), "70");
    const prompt = on.prompt.bytes.toString();
    assert.ok(prompt.startsWith("make it night <sd_cpp_extra_args>"));
    assert.deepEqual(JSON.parse(/<sd_cpp_extra_args>(.*)<\/sd_cpp_extra_args>$/.exec(prompt)![1]), { init_image: null, negative_prompt: "blurry", seed: 9 });

    // The switch off: the same ask sends the description as it is, whatever the request carries.
    await editing.editImage(target(origin, { multiple: true, sdExtras: false }), ask);
    const off = parts(seen[1]);
    assert.equal(off.prompt.bytes.toString(), "make it night");
    assert.deepEqual(Object.keys(off).sort(), Object.keys(on).sort(), "the rest is as it was");
    // Nothing set, nothing added, with the switch on as well.
    await editing.editImage(target(origin, { sdExtras: true }), { prompt: "plain", image: PNG, native: {} });
    assert.equal(parts(seen[2]).prompt.bytes.toString(), "plain");
  } finally {
    server.close();
  }
});

test("a picture to edit is checked by its bytes and its size before anything is sent", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    for (const bad of [SVG, Buffer.from("<html><script>alert(1)</script></html>"), Buffer.from("not a picture at all"), Buffer.alloc(0)]) {
      await assert.rejects(editing.editImage(target(origin), { prompt: "p", image: bad }), /The image is not a PNG, JPEG, GIF or WebP picture/);
      await assert.rejects(editing.editImage(target(origin), { prompt: "p", image: PNG, mask: bad }), /The mask is not a PNG, JPEG, GIF or WebP picture/);
    }
    const big = Buffer.concat([PNG, Buffer.alloc(4096)]);
    // Too heavy is scaled down, and what is no picture that can be read cannot be: refused, and nothing is sent.
    await assert.rejects(editing.editImage(target(origin), { prompt: "p", image: big }, { maxInputBytes: 1024 }), /The image cannot be made to fit an edit: its size cannot be read.*Nothing was sent/);
    await assert.rejects(editing.editImage(target(origin), { prompt: "p", image: PNG, mask: big }, { maxInputBytes: 1024 }), /The mask cannot be made to fit an edit/);
    assert.equal(seen.length, 0, "nothing left the portal");
    assert.equal((await editing.editImage(target(origin), { prompt: "p", image: big }, { maxInputBytes: 1024 * 1024 })).ext, "png");
  } finally {
    server.close();
  }
});

test("the answer to an edit is read, limited and kept from the key as one to a generation is", async () => {
  let answer: unknown = { data: [{ url: `data:image/png;base64,${b64(PNG)}` }] };
  const { origin, seen, server } = await fake((req, res) => {
    if (req.url === "/files/own.png") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(GIF);
    json(res, answer, answer === "error" ? 401 : 200);
  });
  const ask = (more: Partial<ReturnType<typeof target>> = {}, options = {}) => editing.editImage(target(origin, more), { prompt: "p", image: PNG }, options);
  try {
    assert.equal((await ask()).ext, "png", "a data URL");
    answer = { data: [{ url: `${origin}/files/own.png` }] };
    assert.equal((await ask()).ext, "gif", "an address on the endpoint's own host, fetched with the key, whatever it is served as");
    assert.equal(seen.at(-1)!.auth, `Bearer ${KEY}`);

    // Only a picture counts, and only up to the limit.
    answer = { data: [{ b64_json: b64(SVG) }] };
    await assert.rejects(ask(), /not a PNG, JPEG, GIF or WebP picture/);
    answer = { data: [] };
    await assert.rejects(ask(), /no picture in it/);
    answer = { data: [{ b64_json: b64(Buffer.concat([PNG, Buffer.alloc(4096)])) }] };
    await assert.rejects(ask({}, { maxBytes: 1024 }), /over/);

    // An error is passed on without the key, even where the endpoint repeats it.
    answer = "error";
    const failing = await fake((_req, res) => json(res, { error: { message: `Invalid key ${KEY} for model edit-model` } }, 401));
    try {
      await assert.rejects(editing.editImage(target(failing.origin), { prompt: "p", image: PNG }), (e: Error) => {
        assert.match(e.message, /answered 401: Invalid key \[key\] for model/);
        assert.ok(!e.message.includes(KEY));
        return true;
      });
    } finally {
      failing.server.close();
    }
  } finally {
    server.close();
  }
});

test("an edit's picture is never fetched from another place on this machine, and the endpoint is never followed elsewhere", async () => {
  const inner = await fake((_req, res) => res.writeHead(200).end(PNG));
  const { origin, server } = await fake((_req, res) => json(res, { data: [{ url: `${inner.origin}/secret.png` }] }));
  const redirecting = await fake((_req, res) => res.writeHead(307, { location: `${inner.origin}/v1/images/edits` }).end());
  try {
    await assert.rejects(editing.editImage(target(origin), { prompt: "p", image: PNG }), /another host than the endpoint, and is only fetched from there over https/);
    await assert.rejects(editing.editImage(target(redirecting.origin), { prompt: "p", image: PNG }), /answered with a redirect, which is not followed/);
    assert.equal(inner.seen.length, 0, "nothing was asked of the other place, and it was sent no key");
  } finally {
    server.close();
    redirecting.server.close();
    inner.server.close();
  }
});

test("an edit that is never answered is given up on, and a chat that is stopped stops it", async () => {
  const { origin, server } = await fake(() => {});
  try {
    await assert.rejects(editing.editImage(target(origin), { prompt: "p", image: PNG }, { timeoutMs: 150 }), /did not answer within/);
    const stop = new AbortController();
    const slow = editing.editImage(target(origin), { prompt: "p", image: PNG }, { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    await assert.rejects(slow, (e: Error) => !(e instanceof gen.ImageGenerationError) && /abort/i.test(e.name));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the time limit is a setting: five minutes without one, whole seconds from 30 to 3600, and kept", () => {
  reset();
  assert.equal(gen.imageGenerationConfig().timeoutSeconds, 300, "a fresh install has five minutes, not the old 180 seconds");
  assert.equal(gen.imageGenerationState().timeoutSeconds, 300);
  assert.equal(gen.imageEditingTarget().timeoutSeconds, 300, "editing has the same limit");

  const parse = gen.parseImageGenerationPatch;
  assert.deepEqual(parse({ timeoutSeconds: 30 }), { timeoutSeconds: 30 });
  assert.deepEqual(parse({ timeoutSeconds: 3600 }), { timeoutSeconds: 3600 });
  for (const bad of [29, 3601, 0, -300, 90.5, "300", NaN, Infinity]) {
    assert.match(String(parse({ timeoutSeconds: bad })), /whole number of seconds from 30 to 3600/, String(bad));
  }

  gen.saveImageGeneration({ timeoutSeconds: 900 });
  assert.equal(gen.imageGenerationConfig().timeoutSeconds, 900);
  assert.equal(gen.imageGenerationState().timeoutSeconds, 900);
  assert.equal(gen.imageEditingTarget().timeoutSeconds, 900, "generation and editing share it");
  gen.saveImageGeneration({ model: "m" });
  assert.equal(gen.imageGenerationConfig().timeoutSeconds, 900, "another change leaves it");

  // Saving something else does not store the default as if it had been chosen: a setup that never chose one keeps getting the default of the day.
  reset();
  putSetting("image_generation", JSON.stringify({ enabled: true, baseUrl: "https://images.example.com/v1" }));
  gen.saveImageGeneration({ model: "m" });
  assert.ok(!("timeoutSeconds" in JSON.parse(getSetting("image_generation")!)), "not written");
  gen.saveImageGeneration({ timeoutSeconds: 300 });
  assert.equal(JSON.parse(getSetting("image_generation")!).timeoutSeconds, 300, "written once chosen");
  gen.saveImageGeneration({ model: "n" });
  assert.equal(JSON.parse(getSetting("image_generation")!).timeoutSeconds, 300, "and kept");
  gen.saveImageGeneration({ timeoutSeconds: 900 });
  assert.deepEqual(parse({ timeoutSeconds: null }), { timeoutSeconds: null }, "null takes it away");
  assert.equal(gen.saveImageGeneration({ timeoutSeconds: null }).timeoutSeconds, 300);
  assert.ok(!("timeoutSeconds" in JSON.parse(getSetting("image_generation")!)), "the default is the default of the day again");
  assert.equal(gen.imageGenerationConfig().timeoutSeconds, 300);

  // A setup saved before there was a limit, or with one that is no limit, gets the default.
  putSetting("image_generation", JSON.stringify({ enabled: true, baseUrl: "https://images.example.com/v1" }));
  assert.equal(gen.imageGenerationConfig().timeoutSeconds, 300);
  for (const bad of [0, 5, 99999, "600", null, 12.5]) {
    putSetting("image_generation", JSON.stringify({ timeoutSeconds: bad }));
    assert.equal(gen.imageGenerationConfig().timeoutSeconds, 300, `stored ${JSON.stringify(bad)}`);
  }
  reset();
});

test("a picture that takes longer than the old limit is waited for, one past the setting is not, and the message says so", async () => {
  // A fake slow endpoint: it answers after 1.4 seconds.
  const { origin, server } = await fake((_req, res) => setTimeout(() => json(res, { data: [{ b64_json: b64(PNG) }] }), 1400));
  try {
    assert.equal((await gen.generateImage(config(origin, { timeoutSeconds: 3 }), { prompt: "p" })).ext, "png", "within the setting");
    await assert.rejects(gen.generateImage(config(origin, { timeoutSeconds: 1 }), { prompt: "p" }), (e: Error) => {
      assert.ok(e instanceof gen.ImageGenerationError);
      assert.match(e.message, /did not answer within 1 seconds/, "it names the limit");
      assert.match(e.message, /time limit in Settings → Agent → Media/, "and where to change it");
      return true;
    });
    // Editing has the same limit, from its target.
    assert.equal((await editing.editImage(target(origin, { timeoutSeconds: 3 }), { prompt: "p", image: PNG })).ext, "png");
    await assert.rejects(editing.editImage(target(origin, { timeoutSeconds: 1 }), { prompt: "p", image: PNG }), /did not answer within 1 seconds.*time limit in Settings → Agent → Media/);
    // An explicit limit of the call still wins, as the tests above use it.
    await assert.rejects(gen.generateImage(config(origin, { timeoutSeconds: 3 }), { prompt: "p" }, { timeoutMs: 150 }), /did not answer within 0 seconds/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// --- several pictures ---

test("a request may say the editing endpoint takes several pictures, and it is off until it does", () => {
  const parse = gen.parseImageGenerationPatch;
  assert.deepEqual(parse({ editMultiple: true }), { editMultiple: true });
  assert.deepEqual(parse({ editMultiple: false }), { editMultiple: false });
  assert.equal(typeof parse({ editMultiple: "yes" }), "string");
  assert.equal(typeof parse({ editMultiple: 1 }), "string");

  reset();
  assert.equal(gen.imageGenerationConfig().editMultiple, false, "a fresh install takes one picture");
  assert.equal(gen.imageGenerationState().editMultiple, false);
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true });
  assert.equal(gen.imageEditingMultiple(), false, "editing on is not several pictures on");
  assert.equal(gen.imageEditingTarget().multiple, false);
  gen.saveImageGeneration({ editMultiple: true });
  assert.equal(gen.imageEditingMultiple(), true);
  assert.equal(gen.imageEditingTarget().multiple, true);
  assert.equal(gen.imageGenerationState().editMultiple, true);
  // It is the edit tool's shape, so it counts only while there is one.
  gen.saveImageGeneration({ editEnabled: false });
  assert.equal(gen.imageEditingMultiple(), false);
  reset();
});

test("what only stable-diffusion.cpp reads is said of the endpoint: either address moving to another server takes the switch off, or the page would send it a block it takes as words", () => {
  reset();
  gen.saveImageGeneration({ baseUrl: "http://sd-box.example:1234/v1", enabled: true, editEnabled: true, sdExtras: true });
  gen.saveImageGeneration({ baseUrl: "http://sd-box.example:1234/v2", model: "m" });
  assert.equal(gen.imageGenerationConfig().sdExtras, true, "the same server by another route");
  gen.saveImageGeneration({ editBaseUrl: "http://sd-box.example:1234/edit" });
  assert.equal(gen.imageGenerationConfig().sdExtras, true, "and by an address of its own");
  gen.saveImageGeneration({ baseUrl: "https://api.other.example/v1" });
  assert.equal(gen.imageGenerationConfig().sdExtras, false, "generation moved");
  assert.equal(gen.imageGenerationState().sdExtras, false);
  assert.equal(gen.imageEditingTarget().sdExtras, false);
  // Said again, it is what was said for the new server; and in the same save as the move, too.
  gen.saveImageGeneration({ sdExtras: true });
  assert.equal(gen.imageGenerationConfig().sdExtras, true);
  gen.saveImageGeneration({ baseUrl: "https://third.example.org/v1", sdExtras: true });
  assert.equal(gen.imageGenerationConfig().sdExtras, true);
  // Edits that go elsewhere than generation, moved to another server: one switch covers both, so it goes off.
  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v1" });
  assert.equal(gen.imageGenerationConfig().sdExtras, false, "edits moved");
  // A first address is no move: it may be given with the switch, or before it.
  reset();
  gen.saveImageGeneration({ sdExtras: true });
  gen.saveImageGeneration({ baseUrl: "http://sd-box.example:1234/v1", enabled: true });
  assert.equal(gen.imageGenerationConfig().sdExtras, true);
  // Edits that follow generation's address follow its server.
  gen.saveImageGeneration({ baseUrl: "https://elsewhere.example.org/v1" });
  assert.equal(gen.imageGenerationConfig().sdExtras, false);
  reset();
});

test("what an endpoint takes is said of that endpoint: another server is not assumed to take several pictures", () => {
  reset();
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true, editMultiple: true });
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v2" });
  assert.equal(gen.imageGenerationConfig().editMultiple, true, "the same server by another route");
  gen.saveImageGeneration({ editBaseUrl: "https://images.example.com/edit" });
  assert.equal(gen.imageGenerationConfig().editMultiple, true, "and by an address of its own");
  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v1" });
  assert.equal(gen.imageGenerationConfig().editMultiple, false, "edits moved to another server: it is not known to take them");
  // Said again for the new server, it stays; and in the same save as the move, it is what was said.
  gen.saveImageGeneration({ editMultiple: true });
  gen.saveImageGeneration({ editBaseUrl: "https://third.example.org/v1", editMultiple: true });
  assert.equal(gen.imageGenerationConfig().editMultiple, true);
  // Generation's address moving does not touch edits that have an address of their own.
  gen.saveImageGeneration({ baseUrl: "https://elsewhere.example.org/v1" });
  assert.equal(gen.imageGenerationConfig().editMultiple, true);
  // Edits that follow generation's address follow its server, too.
  gen.saveImageGeneration({ editBaseUrl: "", editMultiple: true });
  gen.saveImageGeneration({ baseUrl: "https://another.example.org/v1" });
  assert.equal(gen.imageGenerationConfig().editMultiple, false);
  // Said before there was an address, it was said of none, and goes with the first.
  reset();
  gen.saveImageGeneration({ editMultiple: true });
  gen.saveImageGeneration({ editBaseUrl: "https://edit.example.net/v1" });
  assert.equal(gen.imageGenerationConfig().editMultiple, true);
  reset();
});

test("several pictures are one request, each as image[] in the order given, and only to an endpoint that takes them", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(WEBP) }] }));
  try {
    const several = target(origin, { multiple: true });
    const got = await editing.editImage(several, { prompt: "put the cat from the second into the first", image: [PNG, JPEG, GIF] });
    assert.deepEqual(got.bytes, WEBP);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/images/edits");
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    const list = partList(seen[0]);
    assert.deepEqual(list.map((part) => part.name), ["image[]", "image[]", "image[]", "prompt", "model", "n"], "one part for each, first, in order");
    assert.deepEqual(list.slice(0, 3).map((part) => part.bytes), [PNG, JPEG, GIF]);
    assert.deepEqual(list.slice(0, 3).map((part) => part.type), ["image/png", "image/jpeg", "image/gif"], "the type each one's bytes say");
    assert.deepEqual(list.slice(0, 3).map((part) => part.filename), ["image-1.png", "image-2.jpg", "image-3.gif"], "neutral names that say only the place");
    assert.equal(parts(seen[0]).prompt.bytes.toString(), "put the cat from the second into the first", "the prompt is the agent's, as it is");

    // A mask goes with them as it does with one.
    await editing.editImage(several, { prompt: "p", image: [PNG, JPEG], mask: GIF });
    assert.deepEqual(partList(seen[1]).map((part) => part.name), ["image[]", "image[]", "mask", "prompt", "model", "n"]);

    // A list of one is the request an endpoint that takes one is sent, whether the endpoint takes several or not.
    for (const multiple of [true, false]) {
      await editing.editImage(target(origin, { multiple }), { prompt: "p", image: [WEBP] });
      const one = partList(seen.at(-1)!);
      assert.deepEqual(one.map((part) => part.name), ["image", "prompt", "model", "n"], `multiple: ${multiple}`);
      assert.equal(one[0].filename, "image.webp");
    }
    const before = seen.length;

    // Not to one that was not said to: nothing is sent.
    await assert.rejects(editing.editImage(target(origin), { prompt: "p", image: [PNG, JPEG] }), /not set up to take several pictures, so none was sent/);
    assert.equal(seen.length, before);
  } finally {
    server.close();
  }
});

test("several pictures are limited in number and in weight, and one that is refused refuses them all before anything is sent", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    const several = target(origin, { multiple: true });
    const ask = (image: Buffer[], options = {}) => editing.editImage(several, { prompt: "p", image }, options);
    assert.equal((await ask(Array(editing.MAX_EDIT_PICTURES).fill(PNG))).ext, "png", "as many as an edit takes");
    const sent = seen.length;
    await assert.rejects(ask(Array(editing.MAX_EDIT_PICTURES + 1).fill(PNG)), /at most 8 pictures, and 9 were given/);
    await assert.rejects(ask([]), /no picture to change/);

    // By their bytes and size each, and named by their place: the others are fine, but the prompt would no longer match them.
    await assert.rejects(ask([PNG, SVG, JPEG]), /Picture 2 is not a PNG, JPEG, GIF or WebP picture/);
    await assert.rejects(ask([PNG, JPEG, Buffer.alloc(0)]), /Picture 3 is not a PNG/);
    const big = Buffer.concat([PNG, Buffer.alloc(4096)]);
    await assert.rejects(ask([PNG, big], { maxInputBytes: 1024 }), /Picture 2 cannot be made to fit an edit/);
    await assert.rejects(editing.editImage(several, { prompt: "p", image: [PNG, JPEG], mask: SVG }), /The mask is not a PNG/);
    // Together, too: these cannot be scaled (they are padding, not pictures), so the first that is over its share is refused.
    await assert.rejects(ask([big, big, big], { maxTotalBytes: 10 * 1024 }), /Picture 1 cannot be made to fit an edit/);
    assert.equal((await ask([big, big], { maxTotalBytes: 10 * 1024 })).ext, "png", "within the weight");
    assert.equal(seen.length, sent + 1, "nothing was sent for any of the refusals");
    assert.equal(editing.MAX_EDIT_TOTAL_BYTES, 50 * 1024 * 1024);
  } finally {
    server.close();
  }
});

/** The editing tool as pi gets it, and a way to call it. */
function loadEdit(folder: string) {
  const tool = new EditImageTool(folder);
  const registered: any[] = [];
  tool.extension({ registerTool: (t: any) => registered.push(t) });
  return { tool, registered, call: (p: any, signal?: AbortSignal) => registered[0].execute("id", p, signal) };
}

/** A chat's folder with a picture in it. */
function chatWith(files: Record<string, Buffer> = { "photo.png": PNG }) {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), bytes);
  }
  return folder;
}

test("while editing is off, or has no address, the edit tool is not there at all", () => {
  reset();
  const folder = chatWith();
  const off = loadEdit(folder);
  assert.deepEqual(off.registered, []);
  assert.equal(off.tool.registered(), false);

  // Generation on is not editing on.
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", enabled: true });
  assert.deepEqual(loadEdit(folder).registered, []);
  assert.deepEqual(load(folder).registered.map((t) => t.name), ["generate_image"], "and the other way round");

  gen.saveImageGeneration({ editEnabled: true });
  const on = loadEdit(folder);
  assert.deepEqual(on.registered.map((t) => t.name), ["edit_image"]);
  assert.equal(on.tool.registered(), true);

  // Loaded again after a switch, as pi does on a reload: it follows.
  gen.saveImageGeneration({ editEnabled: false });
  on.tool.extension({ registerTool: () => assert.fail("not while it is off") });
  assert.equal(on.tool.registered(), false);
  reset();
});

test("the tool changes a picture of the chat's folder into a new one next to its kind and answers as generate_image does", async () => {
  const folder = chatWith({ "photo.png": PNG, "shots/other.jpg": JPEG });
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(WEBP) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, model: "generation-model", apiKey: KEY, editEnabled: true, editModel: "edit-model" });
    const { call, registered } = loadEdit(folder);
    assert.deepEqual(Object.keys(registered[0].parameters.properties).sort(), ["path", "prompt", "title"]);
    assert.ok(!JSON.stringify(registered[0]).includes(KEY));

    const result = await call({ path: "photo.png", prompt: "  make the sky purple  ", title: "Purple sky" });
    assert.equal(result.details.path, "generated-images/photo-edited.webp", "named after the original, with the type of the result");
    assert.deepEqual(result.details, { path: "generated-images/photo-edited.webp", title: "Purple sky", [GENERATED_PICTURE_MARK]: true });
    assert.match(result.content[0].text, /Edited photo\.png, and shown to the user: generated-images\/photo-edited\.webp/);
    assert.deepEqual(readFileSync(path.join(folder, result.details.path)), WEBP);
    assert.deepEqual(readFileSync(path.join(folder, "photo.png")), PNG, "the original stays as it was");

    // What was sent: the picture from the folder, the prompt, and the model of editing, not of generation.
    assert.equal(seen[0].url, "/images/edits");
    assert.equal(seen[0].auth, `Bearer ${KEY}`, "the key of the server it was given for");
    const form = parts(seen[0]);
    assert.deepEqual(form.image.bytes, PNG);
    assert.equal(form.prompt.bytes.toString(), "make the sky purple");
    assert.equal(form.model.bytes.toString(), "edit-model");

    // A second edit of the same picture never takes the first's place; one of an edit does not stack the mark.
    const again = await call({ path: "photo.png", prompt: "make the sky green" });
    assert.equal(again.details.path, "generated-images/photo-edited (2).webp");
    assert.equal(again.details.title, "make the sky green", "without a title, the prompt is the caption");
    const ofEdit = await call({ path: result.details.path, prompt: "and add a moon" });
    assert.equal(ofEdit.details.path, "generated-images/photo-edited (3).webp");
    assert.deepEqual(readFileSync(path.join(folder, result.details.path)), WEBP, "the first is as it was");

    // An absolute path inside the folder, and a picture in a folder of its own: the result is still where the pictures go.
    const inner = await call({ path: path.join(folder, "shots", "other.jpg"), prompt: "p" });
    assert.equal(inner.details.path, "generated-images/other-edited.webp");
    assert.deepEqual(readdirSync(folder).sort(), [GENERATED_DIR, "photo.png", "shots"], "nothing else was made in the folder");
    assert.deepEqual(readdirSync(path.join(folder, "shots")), ["other.jpg"]);
  } finally {
    server.close();
    reset();
  }
});

test("what an edit is called: the original's name, with the mark once, within what a name may be", () => {
  assert.equal(editedName("photo.png", "png"), "photo-edited.png");
  assert.equal(editedName("a/b/photo.final.jpg", "webp"), "photo.final-edited.webp");
  assert.equal(editedName("generated-images/photo-edited.png", "png"), "photo-edited.png", "an edit of an edit: the mark is not stacked, the number is made when it is saved");
  assert.equal(editedName("photo-edited (2).png", "png"), "photo-edited.png");
  assert.equal(editedName(".hidden.png", "png"), ".hidden-edited.png");
  assert.ok(Buffer.byteLength(editedName(`${"x".repeat(300)}.png`, "png")) <= 255 - 10);
  assert.ok(Buffer.byteLength(editedName(`${"é".repeat(300)}.png`, "png")) <= 255 - 10, "by bytes, not by letters");
  // Four bytes a letter: a name of 62 of them (248 bytes) is a valid name, and the result's must be one too, with room for a number.
  const emoji = editedName(`${"😀".repeat(62)}.png`, "webp");
  assert.ok(Buffer.byteLength(emoji) <= 255 - 10, `${Buffer.byteLength(emoji)} bytes`);
  assert.ok(emoji.endsWith("-edited.webp") && !emoji.includes("\uFFFD"), "cut between letters, not inside one");
});

test("an original with a long name of four-byte letters is edited as any other, and a failed save is not what finds out", async () => {
  const name = `${"😀".repeat(62)}.png`;
  assert.equal(Buffer.byteLength(name), 252, "a valid name");
  const folder = chatWith({ [name]: PNG });
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(WEBP) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true });
    const { call } = loadEdit(folder);
    const first = await call({ path: name, prompt: "p" });
    const second = await call({ path: name, prompt: "p" });
    assert.notEqual(first.details.path, second.details.path);
    for (const result of [first, second]) {
      assert.ok(existsSync(path.join(folder, result.details.path)));
      assert.ok(Buffer.byteLength(path.basename(result.details.path)) <= 255);
    }
    assert.equal(seen.length, 2);
  } finally {
    server.close();
    reset();
  }
});

test("the tool reads only what is in the chat's folder, and only a picture: nothing is sent for anything else", async () => {
  const folder = chatWith({ "photo.png": PNG, "notes.txt": Buffer.from("not a picture"), "vector.png": SVG });
  const outside = chatWith({ "secret.png": PNG });
  symlinkSync(path.join(outside, "secret.png"), path.join(folder, "link.png"));
  symlinkSync(outside, path.join(folder, "linked"));
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true });
    const { call } = loadEdit(folder);
    await assert.rejects(call({ path: path.join(outside, "secret.png"), prompt: "p" }), /Only a picture in the chat's folder can be edited/);
    await assert.rejects(call({ path: "../secret.png", prompt: "p" }), /Only a picture in the chat's folder can be edited/);
    await assert.rejects(call({ path: "link.png", prompt: "p" }), /leads outside the folder/);
    await assert.rejects(call({ path: "linked/secret.png", prompt: "p" }), /leads outside the folder/);
    await assert.rejects(call({ path: "notes.txt", prompt: "p" }), /not a PNG, JPEG, GIF or WebP/);
    await assert.rejects(call({ path: "vector.png", prompt: "p" }), /not a PNG, JPEG, GIF or WebP/);
    await assert.rejects(call({ path: "missing.png", prompt: "p" }), /no such file/i);
    await assert.rejects(call({ path: "", prompt: "p" }), /Only a picture in the chat's folder can be edited/);
    await assert.rejects(call({ path: "photo.png", prompt: "   " }), /prompt is required/);
    await assert.rejects(call({ path: "photo.png", prompt: "x".repeat(4001) }), /over 4000 characters/);
    assert.equal(seen.length, 0, "nothing was sent for any of it");
    assert.equal(existsSync(path.join(folder, GENERATED_DIR)), false, "and nothing kept");
    assert.deepEqual(readdirSync(outside), ["secret.png"]);
  } finally {
    server.close();
    reset();
  }
});

test("a picture over the limit is refused as too large for an edit, not told to be downloaded, and nothing is sent", async () => {
  const folder = chatWith({ "small.png": PNG, "huge.png": Buffer.concat([PNG, Buffer.alloc(26 * 1024 * 1024)]) });
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true });
    const { call } = loadEdit(folder);
    await assert.rejects(call({ path: "huge.png", prompt: "p" }), (e: Error) => {
      assert.match(e.message, /over 25 MB, which is more than can be read to be scaled down for an edit/);
      assert.doesNotMatch(e.message, /download/i);
      return true;
    });
    assert.equal(seen.length, 0, "nothing was sent");
    assert.equal(existsSync(path.join(folder, GENERATED_DIR)), false, "and nothing kept");
    assert.equal((await call({ path: "small.png", prompt: "p" })).details.path, "generated-images/small-edited.png", "a picture within the limit is edited as ever");
  } finally {
    server.close();
    reset();
  }
});

test("a failed edit leaves nothing behind: no file, no folder, and the original as it was", async () => {
  const folder = chatWith();
  let answer: unknown = { data: [{ b64_json: b64(SVG) }] };
  let status = 200;
  const { origin, server } = await fake((_req, res) => json(res, answer, status));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true });
    const { call } = loadEdit(folder);
    const untouched = () => {
      assert.equal(existsSync(path.join(folder, GENERATED_DIR)), false, "no folder made for it");
      assert.deepEqual(readdirSync(folder), ["photo.png"]);
      assert.deepEqual(readFileSync(path.join(folder, "photo.png")), PNG);
    };
    await assert.rejects(call({ path: "photo.png", prompt: "p" }), /not a PNG, JPEG, GIF or WebP/);
    untouched();
    answer = { data: [] };
    await assert.rejects(call({ path: "photo.png", prompt: "p" }), /no picture in it/);
    untouched();
    answer = { error: { message: "This model cannot edit" } };
    status = 400;
    await assert.rejects(call({ path: "photo.png", prompt: "p" }), /answered 400: This model cannot edit/);
    untouched();
    // Where there is a folder of the pictures already, a failure adds nothing to it either.
    answer = { data: [{ b64_json: b64(JPEG) }] };
    status = 200;
    await call({ path: "photo.png", prompt: "p" });
    answer = { data: [] };
    await assert.rejects(call({ path: "photo.png", prompt: "p" }));
    assert.deepEqual(readdirSync(path.join(folder, GENERATED_DIR)), ["photo-edited.jpg"]);
    // Nothing is written through a folder that leads out of the chat's, either.
    const outside = mkdtempSync(path.join(temp, "outside-"));
    const other = chatWith();
    symlinkSync(outside, path.join(other, GENERATED_DIR));
    answer = { data: [{ b64_json: b64(PNG) }] };
    await assert.rejects(loadEdit(other).call({ path: "photo.png", prompt: "p" }));
    assert.deepEqual(readdirSync(outside), [], "nothing outside the folder");
    // Switched off since it was loaded: refused.
    gen.saveImageGeneration({ editEnabled: false });
    await assert.rejects(call({ path: "photo.png", prompt: "p" }), /switched off/);
  } finally {
    server.close();
    reset();
  }
});

test("a picture made by the portal can be edited, and the result sits beside it in the generated pictures", async () => {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  const { origin, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, enabled: true, editEnabled: true });
    const made = await load(folder).call({ prompt: "a lighthouse" });
    const edited = await loadEdit(folder).call({ path: made.details.path, prompt: "at night" });
    assert.equal(edited.details.path, made.details.path.replace(/\.png$/, "-edited.png"));
    assert.deepEqual(readdirSync(path.join(folder, GENERATED_DIR)).length, 2);
  } finally {
    server.close();
    reset();
  }
});

test("an endpoint that takes one picture gets a tool with one path, and one that takes several a tool with a list", () => {
  reset();
  const folder = chatWith();
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true });
  const one = loadEdit(folder).registered[0];
  assert.deepEqual(Object.keys(one.parameters.properties).sort(), ["path", "prompt", "title"], "off: the tool is as it was");
  assert.deepEqual(one.parameters.required.sort(), ["path", "prompt"]);
  assert.doesNotMatch(one.description, /place in the list|\bpaths\b/);
  assert.match(one.description, /make a new one from it as reference/, "one picture can be the reference for a new one");

  gen.saveImageGeneration({ editMultiple: true });
  const many = loadEdit(folder).registered[0];
  assert.equal(many.name, "edit_image", "the same tool, not another");
  assert.deepEqual(Object.keys(many.parameters.properties).sort(), ["paths", "prompt", "title"], "a list instead of a path, so that there is one way to say it");
  assert.deepEqual(many.parameters.required.sort(), ["paths", "prompt"]);
  assert.equal(many.parameters.properties.paths.type, "array");
  assert.equal(many.parameters.properties.paths.items.type, "string");
  assert.equal(many.parameters.properties.paths.minItems, 1);
  assert.equal(many.parameters.properties.paths.maxItems, editing.MAX_EDIT_PICTURES);
  assert.match(many.description, /only by their place in the list/, "the model is told how it says which is which");
  assert.match(many.description, /"the first picture", "the second picture"/);
  assert.match(many.description, /refused by name, and then none is sent/);
  assert.ok(!JSON.stringify(many).includes("sk-"));

  // Several with editing off is no tool at all.
  gen.saveImageGeneration({ editEnabled: false });
  assert.deepEqual(loadEdit(folder).registered, []);
  reset();
});

test("an agent whose endpoint takes one picture is told so, and what to do about several, rather than left to use one and say nothing", () => {
  reset();
  const folder = chatWith();
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true });
  const one = loadEdit(folder).registered[0];
  assert.match(one.description, /takes ONE picture per edit/, "the limit is said, not left out");
  assert.match(one.description, /do not edit with one of them; say so/, "no picture is dropped without a word");
  assert.match(one.description, /Settings → Agent → Media \(Several pictures per edit\)/, "and where several are switched on");
  assert.match(one.description, /make a new one from it as reference/, "one reference picture is still what it can be given");
  const attached = /only attached to a message is not in the folder and cannot be used[^]*Files panel[^]*Media page[^]*never guess a path/;
  assert.match(one.description, attached, "a picture only attached to a message has no path: the agent says so rather than guess one");

  // With several taken, the same sentence is not there, and the limits are: the count and the weight.
  gen.saveImageGeneration({ editMultiple: true });
  const many = loadEdit(folder).registered[0];
  assert.doesNotMatch(many.description, /ONE picture|do not edit with one of them/);
  assert.match(many.description, new RegExp(`1 to ${editing.MAX_EDIT_PICTURES} pictures`));
  assert.match(many.description, new RegExp(`at most ${editing.MAX_EDIT_TOTAL_BYTES / 1024 / 1024} MB`));
  assert.match(many.description, /cannot be scaled to fit is refused by name, and then none is sent/);
  // The scaling is said once, for both shapes, with what the model is to do about it.
  for (const description of [one.description, many.description]) assert.match(description, /over the limits is scaled down first and the result says so: tell the person/);
  assert.match(many.description, attached, "and the same for a list: attached pictures cannot be named in it");
  reset();
});

test("a list of pictures for an endpoint that takes one is refused before anything is sent, with the count and the switch that changes it", async () => {
  const folder = chatWith({ "a.png": PNG, "b.jpg": JPEG, "c.gif": GIF });
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(JPEG) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true });
    // A call that was loaded when several were on, or by a model that sends a list anyway: asked of the setting as it is now.
    await assert.rejects(
      loadEdit(folder).call({ paths: ["a.png", "b.jpg", "c.gif"], prompt: "p" }),
      /not set up to take several pictures, so none was sent \(3 were given\)\. .*"Several pictures per edit" can be switched on in Settings → Agent → Media/,
    );
    assert.equal(seen.length, 0, "nothing reached the endpoint");
    assert.deepEqual(readdirSync(folder).sort(), ["a.png", "b.jpg", "c.gif"], "and nothing was written");
    // Switched on, the same three go, in one request, as image[] each.
    gen.saveImageGeneration({ editMultiple: true });
    await loadEdit(folder).call({ paths: ["a.png", "b.jpg", "c.gif"], prompt: "p" });
    assert.equal(partList(seen[0]).filter((part) => part.name === "image[]").length, 3);
  } finally {
    server.close();
    reset();
  }
});

test("the tool makes one picture of several, in the order given, named after the first, and the originals stay", async () => {
  const folder = chatWith({ "person.png": PNG, "style.jpg": JPEG, "shots/pattern.gif": GIF });
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(WEBP) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, apiKey: KEY, editEnabled: true, editMultiple: true, editModel: "edit-model" });
    const { call } = loadEdit(folder);
    const result = await call({ paths: ["person.png", "style.jpg", path.join(folder, "shots", "pattern.gif")], prompt: "the person from the first, painted as the second, on the third", title: "Painted" });
    assert.deepEqual(result.details, { path: "generated-images/person-edited.webp", title: "Painted", [GENERATED_PICTURE_MARK]: true }, "answers as for one picture: the page draws it the same");
    assert.match(result.content[0].text, /Made from person\.png, style\.jpg, shots\/pattern\.gif \(in this order\), and shown to the user: generated-images\/person-edited\.webp/);
    assert.deepEqual(readFileSync(path.join(folder, result.details.path)), WEBP);
    assert.equal(seen.length, 1, "one request for all");
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    const list = partList(seen[0]);
    assert.deepEqual(list.map((part) => part.name), ["image[]", "image[]", "image[]", "prompt", "model", "n"]);
    assert.deepEqual(list.slice(0, 3).map((part) => part.bytes), [PNG, JPEG, GIF], "in the order of the list, with the bytes of the folder's files");
    assert.deepEqual(list.slice(0, 3).map((part) => part.filename), ["image-1.png", "image-2.jpg", "image-3.gif"], "never their names");
    assert.equal(list[3].bytes.toString(), "the person from the first, painted as the second, on the third");
    assert.deepEqual(readFileSync(path.join(folder, "person.png")), PNG);
    assert.deepEqual(readFileSync(path.join(folder, "style.jpg")), JPEG);
    assert.deepEqual(readdirSync(folder).sort(), [GENERATED_DIR, "person.png", "shots", "style.jpg"], "nothing else was made");

    // A second one with the same first picture takes the next number, as an edit does; a list of one is one picture.
    assert.equal((await call({ paths: ["person.png", "style.jpg"], prompt: "p" })).details.path, "generated-images/person-edited (2).webp");
    const single = await call({ paths: ["style.jpg"], prompt: "p" });
    assert.match(single.content[0].text, /^Edited style\.jpg, and shown/);
    assert.deepEqual(partList(seen.at(-1)!).map((part) => part.name), ["image", "prompt", "model", "n"], "sent as one picture is");
    // One path still does as it did, where the tool was loaded with a list.
    assert.equal((await call({ path: "style.jpg", prompt: "p" })).details.path, "generated-images/style-edited (2).webp");
  } finally {
    server.close();
    reset();
  }
});

test("a picture of a list that is refused refuses the call, says which it is, and nothing is sent or kept", async () => {
  const folder = chatWith({
    "a.png": PNG, "b.jpg": JPEG, "notes.txt": Buffer.from("not a picture"), "vector.png": SVG,
    "big-1.png": Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]), "big-2.png": Buffer.concat([JPEG, Buffer.alloc(20 * 1024 * 1024)]), "big-3.png": Buffer.concat([GIF, Buffer.alloc(20 * 1024 * 1024)]),
    "huge.png": Buffer.concat([PNG, Buffer.alloc(26 * 1024 * 1024)]),
  });
  const outside = chatWith({ "secret.png": PNG });
  symlinkSync(path.join(outside, "secret.png"), path.join(folder, "link.png"));
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true, editMultiple: true });
    const { call } = loadEdit(folder);
    const refused = (paths: string[], message: RegExp) => assert.rejects(call({ paths, prompt: "p" }), (e: Error) => { assert.match(e.message, message); return true; });
    await refused(["a.png", path.join(outside, "secret.png")], /^Picture 2 \(.*secret\.png\): Only a picture in the chat's folder can be edited/);
    await refused(["a.png", "../secret.png", "b.jpg"], /^Picture 2 \(\.\.\/secret\.png\): Only a picture in the chat's folder can be edited/);
    await refused(["link.png", "a.png"], /^Picture 1 \(link\.png\): .*leads outside the folder/);
    await refused(["a.png", "b.jpg", "notes.txt"], /^Picture 3 \(notes\.txt\): .*not a PNG, JPEG, GIF or WebP/);
    await refused(["vector.png", "a.png"], /^Picture 1 \(vector\.png\): .*not a PNG, JPEG, GIF or WebP/);
    await refused(["a.png", "missing.png"], /^Picture 2 \(missing\.png\): .*no such file/i);
    await refused(["a.png", ""], /^Picture 2 \(\): Only a picture in the chat's folder can be edited/);
    await refused(["a.png", "huge.png"], /^Picture 2 \(huge\.png\): The picture is over 25 MB, which is more than can be read to be scaled down for an edit/);
    // Each within the limit of a picture, but not together: they would be scaled down to share the 50 MB, which these (padding, not pictures) cannot be.
    await refused(["big-1.png", "big-2.png", "big-3.png"], /^Picture 1 cannot be made to fit an edit/);
    await refused(Array(editing.MAX_EDIT_PICTURES + 1).fill("a.png"), /at most 8 pictures, and 9 were given/);
    await refused([], /no picture to change/);
    await assert.rejects(call({ paths: ["a.png", 5], prompt: "p" }), /Picture 2 \(5\): Name the picture by its path/);
    await assert.rejects(call({ paths: ["a.png", "b.jpg"], prompt: "  " }), /prompt is required/);
    assert.equal(seen.length, 0, "nothing was sent for any of it");
    assert.equal(existsSync(path.join(folder, GENERATED_DIR)), false, "and nothing kept");
    assert.deepEqual(readdirSync(outside), ["secret.png"]);
    // What is in bounds is made as ever.
    assert.equal((await call({ paths: ["big-1.png", "big-2.png"], prompt: "p" })).details.path, "generated-images/big-1-edited.png");
    assert.equal((await call({ paths: Array(editing.MAX_EDIT_PICTURES).fill("a.png"), prompt: "p" })).details.path, "generated-images/a-edited.png");
  } finally {
    server.close();
    reset();
  }
});

test("the setting is read at each call: a list is refused once the endpoint is no longer said to take it, and a path or a list does for the shape it was loaded with", async () => {
  const folder = chatWith({ "a.png": PNG, "b.jpg": JPEG });
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(WEBP) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true, editMultiple: true });
    const withList = loadEdit(folder);
    gen.saveImageGeneration({ editMultiple: false });
    await assert.rejects(withList.call({ paths: ["a.png", "b.jpg"], prompt: "p" }), /not set up to take several pictures, so none was sent/);
    assert.equal(seen.length, 0, "nothing was sent");
    assert.ok((await withList.call({ paths: ["a.png"], prompt: "p" })).details.path, "one picture is as ever");

    // Switched on since the tool was loaded with one path: the person's setting is in force at once, for the call that names several.
    const withPath = loadEdit(folder);
    gen.saveImageGeneration({ editMultiple: true });
    assert.equal((await withPath.call({ paths: ["a.png", "b.jpg"], prompt: "p" })).details.path, "generated-images/a-edited (2).webp");
    assert.equal(partList(seen.at(-1)!).filter((part) => part.name === "image[]").length, 2);
    // And switched off with editing since: there is nothing to call.
    gen.saveImageGeneration({ editEnabled: false });
    await assert.rejects(withPath.call({ paths: ["a.png"], prompt: "p" }), /switched off/);
  } finally {
    server.close();
    reset();
  }
});

test("the API holds the edit settings, never gives a key back, and reloads chats when the edit tool comes or goes", async () => {
  const express = (await import("express")).default;
  const { featuresRouter } = await import("../server/src/api/features.ts");
  const app = express().use(express.json()).use("/api", featuresRouter());
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${at}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    assert.ok(!text.includes("edit-key") && !text.includes(KEY), `${method} ${p} gave a key back`);
    return { status: r.status, body: JSON.parse(text) };
  };
  try {
    reset();
    assert.equal((await call("PUT", "/features/images", { editEnabled: true })).status, 400, "nowhere to ask yet");
    assert.equal((await call("PUT", "/features/images", { editBaseUrl: "https://u:p@h.example/v1" })).status, 400);
    assert.equal((await call("PUT", "/features/images", { editEnabled: "yes" })).status, 400);

    const saved = await call("PUT", "/features/images", { editBaseUrl: "https://edit.example.net/v1", editModel: "edit-model", editApiKey: "edit-key" });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { images: fresh({ editBaseUrl: "https://edit.example.net/v1", editModel: "edit-model", editKeySet: true }), changed: false, reloaded: 0, waiting: 0 });
    const on = await call("PUT", "/features/images", { editEnabled: true });
    assert.equal(on.body.changed, true, "the tool is there from now on: chats are reloaded");
    assert.equal(on.body.images.editReady, true);
    assert.equal((await call("PUT", "/features/images", { editModel: "other" })).body.changed, false, "the model is read at each call: no reload");
    assert.equal((await call("GET", "/features/images")).body.images.editKeySet, true);
    const all = await call("GET", "/features");
    assert.equal(all.body.images.editKeySet, true);
    assert.ok(!("editApiKey" in all.body.images));
    assert.equal((await call("PUT", "/features/images", { editApiKey: "" })).body.images.editKeySet, false);
    // Generation coming on does not change what edits have; editing going off is a change.
    assert.equal((await call("PUT", "/features/images", { baseUrl: "https://images.example.com/v1", enabled: true })).body.changed, true, "generation's own tool came");
    assert.equal((await call("PUT", "/features/images", { editEnabled: false })).body.changed, true);
  } finally {
    portal.close();
    reset();
  }
});

test("the API says whether several pictures are taken, and reloads chats when that changes the edit tool", async () => {
  const express = (await import("express")).default;
  const { featuresRouter } = await import("../server/src/api/features.ts");
  const app = express().use(express.json()).use("/api", featuresRouter());
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${at}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    reset();
    assert.equal((await call("GET", "/features/images")).body.images.editMultiple, false, "off by default");
    assert.equal((await call("PUT", "/features/images", { editMultiple: "yes" })).status, 400);
    // Without an edit tool there is no shape to change: said, but nobody is reloaded.
    const early = await call("PUT", "/features/images", { baseUrl: "https://images.example.com/v1", editMultiple: true });
    assert.equal(early.body.images.editMultiple, true);
    assert.equal(early.body.changed, false);
    assert.equal((await call("PUT", "/features/images", { editEnabled: true })).body.changed, true, "the tool came, with a list");
    assert.equal((await call("PUT", "/features/images", { editMultiple: false })).body.changed, true, "the tool is one with a path now: chats are reloaded");
    assert.equal((await call("PUT", "/features/images", { editMultiple: false })).body.changed, false, "said again: nothing to do");
    assert.equal((await call("PUT", "/features/images", { editMultiple: true })).body.changed, true);
    // Moving edits to another server takes it off, which the tool's shape follows.
    const moved = await call("PUT", "/features/images", { editBaseUrl: "https://edit.example.net/v1" });
    assert.equal(moved.body.images.editMultiple, false);
    assert.equal(moved.body.changed, true);
    assert.equal((await call("GET", "/features")).body.images.editMultiple, false);
  } finally {
    portal.close();
    reset();
  }
});

test("a tool rule for edit_image is matched on each picture, whether it is named by path or by a list, never on the list's JSON", async () => {
  const { ruleAllows, guardExtension } = await import("../server/src/pi/guard.ts");
  const { addToolRule, deleteToolRule, listToolRules } = await import("../server/src/db.ts");
  const rule = (pattern: string, more: Record<string, unknown> = {}) =>
    ({ id: `r-${pattern}`, role: "colleague", tool: "edit_image", pattern, note: "", created_at: "", person_key: null, ...more }) as Parameters<typeof ruleAllows>[0][number];
  const allows = (rules: ReturnType<typeof rule>[], input: Record<string, unknown>, role = "colleague") => ruleAllows(rules, role, "edit_image", input);

  const folder = [rule("shared/*")];
  assert.equal(allows(folder, { path: "shared/a.png", prompt: "p" }), true, "one picture, as ever");
  assert.equal(allows(folder, { path: "private.png", prompt: "p" }), false);
  // A list is the same pictures one by one: a folder rule that allowed each still does, and one that did not allow one does not allow the call.
  assert.equal(allows(folder, { paths: ["shared/a.png"], prompt: "p" }), true, "a list of one is the one picture");
  assert.equal(allows(folder, { paths: ["shared/a.png", "shared/b.jpg"], prompt: "p" }), true);
  assert.equal(allows(folder, { paths: ["shared/a.png", "private.png"], prompt: "p" }), false, "one that is not allowed is enough");
  assert.equal(allows(folder, { paths: ["private.png", "shared/a.png"], prompt: "p" }), false, "wherever it is in the list");

  // A rule for a word is not met by the prompt or by another picture of the list, which the call's JSON would have let through.
  const word = [rule("*shared/*")];
  assert.equal(allows(word, { path: "private.png", prompt: "like shared/x" }), false);
  assert.equal(allows(word, { paths: ["private.png"], prompt: "like shared/x" }), false, "the prompt is no picture");
  assert.equal(allows(word, { paths: ["private.png", "shared/a.png"], prompt: "p" }), false, "nor is another picture of the list");
  assert.equal(allows(word, { paths: ["x/shared/a.png", "y/shared/b.png"], prompt: "p" }), true);

  // Each picture needs a rule, not the same one: two folders, two rules.
  assert.equal(allows([rule("shared/*"), rule("pictures/*")], { paths: ["shared/a.png", "pictures/b.png"], prompt: "p" }), true);
  assert.equal(allows([rule("shared/*"), rule("pictures/*")], { paths: ["shared/a.png", "other/b.png"], prompt: "p" }), false);

  // Whichever name the tool would use is checked: a path that is allowed does not carry a list that is not, nor the other way round.
  assert.equal(allows(folder, { path: "shared/a.png", paths: ["private.png"], prompt: "p" }), false);
  assert.equal(allows(folder, { path: "private.png", paths: ["shared/a.png"], prompt: "p" }), false);
  assert.equal(allows(folder, { paths: "private.png", prompt: "p" }), false, "a list given as text, as pi may coerce it");
  // A call that names no picture, an empty list, or something that is no name is allowed by nothing, even by a rule for everything.
  const anything = [rule("*")];
  for (const input of [{ prompt: "p" }, { paths: [], prompt: "p" }, { paths: [""], prompt: "p" }, { paths: ["a.png", 5], prompt: "p" }, { path: 5, prompt: "p" }]) {
    assert.equal(allows(anything, input), false, JSON.stringify(input));
  }
  assert.equal(allows(anything, { paths: ["a.png", "b.png"], prompt: "p" }), true);

  // The rule's role, person and tool count as for any call.
  assert.equal(allows(folder, { paths: ["shared/a.png"], prompt: "p" }, "stranger"), false);
  assert.equal(allows([rule("shared/*", { role: "all" })], { paths: ["shared/a.png"], prompt: "p" }, "stranger"), true);
  assert.equal(allows([rule("shared/*", { tool: "show_image" })], { paths: ["shared/a.png"], prompt: "p" }), false);
  assert.equal(ruleAllows([rule("shared/*", { person_key: "priya" })], "colleague", "edit_image", { paths: ["shared/a.png"] }, "priya"), true);
  assert.equal(ruleAllows([rule("shared/*", { person_key: "priya" })], "colleague", "edit_image", { paths: ["shared/a.png"] }, "sam"), false);

  // Other tools are matched as they were: a command, a path, or the call's own arguments.
  const bash = (pattern: string) => rule(pattern, { tool: "bash" });
  assert.equal(ruleAllows([bash("ls*")], "colleague", "bash", { command: "ls -l 2>&1" }), true);
  assert.equal(ruleAllows([bash("ls*")], "colleague", "bash", { command: "ls; rm x" }), false);
  assert.equal(ruleAllows([rule("docs/*", { tool: "write" })], "colleague", "write", { path: "docs/a.md", content: "x" }), true);
  assert.equal(ruleAllows([rule("*shared*", { tool: "other_tool" })], "colleague", "other_tool", { paths: ["a"], note: "shared" }), true, "a tool of another name keeps its arguments' JSON");

  // As the guard asks it, with the rules in the portal's own table: the call goes through for the pictures the rule allows and is refused for the rest.
  const added = [{ id: "issue90-a", pattern: "shared/*" }];
  for (const r of added) addToolRule({ id: r.id, role: "colleague", tool: "edit_image", pattern: r.pattern, note: "", person_key: null });
  try {
    assert.equal(listToolRules().filter((r) => r.id === "issue90-a").length, 1);
    let handler: ((event: any) => any) | undefined;
    guardExtension("/tmp/none", () => ({ role: "colleague" }), "chat-issue90")({ on: (name: string, fn: (event: any) => any) => { if (name === "tool_call") handler = fn; } });
    const asked = (input: Record<string, unknown>) => handler!({ toolName: "edit_image", input });
    assert.equal(asked({ paths: ["shared/a.png", "shared/b.png"], prompt: "p" }), undefined, "allowed");
    assert.equal(asked({ paths: ["shared/a.png"], prompt: "like shared/x" }), undefined);
    assert.equal(asked({ paths: ["private.png"], prompt: "like shared/x" })?.block, true, "refused: the prompt is not a rule's business");
    assert.equal(asked({ paths: ["shared/a.png", "private.png"], prompt: "p" })?.block, true);
  } finally {
    for (const r of added) deleteToolRule(r.id);
  }
});

test("a colleague's edit_image call can be approved once or always, with the action the guard asks for, in either shape of the tool", async () => {
  const { guardExtension, callSubject, rulePatterns } = await import("../server/src/pi/guard.ts");
  const { deleteToolRule, listToolRules } = await import("../server/src/db.ts");
  const { askQuestion, readAnswer } = await import("../server/src/questions.ts");
  const { recordApproval } = await import("../server/src/approvals.ts");

  // What the guard calls a call: the path, or the path of each picture, one to a line, never the prompt.
  assert.equal(callSubject("edit_image", { path: "shared/a.png", prompt: "p" }), "shared/a.png", "as it was");
  assert.equal(callSubject("edit_image", { paths: ["shared/a.png"], prompt: "p" }), "shared/a.png", "a list of one is its picture");
  assert.equal(callSubject("edit_image", { paths: ["shared/a.png", " shared/b.jpg "], prompt: "other" }), "shared/a.png\nshared/b.jpg");
  assert.equal(callSubject("edit_image", { prompt: "p" }), JSON.stringify({ prompt: "p" }), "a call that names nothing is shown as it is");
  assert.equal(callSubject("bash", { command: " ls " }), "ls");
  assert.equal(callSubject("write", { path: "docs/a.md" }), "docs/a.md");
  assert.deepEqual(rulePatterns("edit_image", "shared/a.png\n shared/b.jpg \n"), ["shared/a.png", "shared/b.jpg"], "one rule for each picture");
  assert.deepEqual(rulePatterns("edit_image", "Summer, 2026.png"), ["Summer, 2026.png"], "a comma is part of a name");
  assert.deepEqual(rulePatterns("bash", "ls\nmore"), ["ls\nmore"], "other tools' actions are one pattern as they were");

  const session = "chat-issue90-approval";
  const person = { role: "colleague", key: "priya" };
  let handler: ((event: any) => any) | undefined;
  let who: { role: string; key?: string } = person;
  guardExtension("/tmp/none", () => who, session)({ on: (name: string, fn: (event: any) => any) => { if (name === "tool_call") handler = fn; } });
  const call = (input: Record<string, unknown>) => handler!({ toolName: "edit_image", input });
  /** What the agent does with a refusal: asks with the action it names, as ask_primary files it, and the primary answers. */
  const approve = (refused: any, answer: string) => {
    assert.equal(refused?.block, true);
    assert.match(refused.reason, /actionTool is edit_image/);
    const action = refused.reason.split("exactly:\n")[1].trim();
    const row = askQuestion({ sessionId: session, personKey: "priya", personName: "Priya", channelSlug: "chat", channelKey: "k", question: "may I?", actionTool: "edit_image", action });
    const pending = readAnswer(`#${row.id} ${answer}`)!;
    recordApproval(pending.question, { id: session }, pending.approves, pending.always);
    return action;
  };
  try {
    // Once, for several pictures: refused, told what to ask for, approved, then it runs, and only once.
    const several = { paths: ["shared/logo.png", "Summer, banner.png"], prompt: "put the logo on the banner" };
    assert.equal(approve(call(several), "approve"), "shared/logo.png\nSummer, banner.png");
    assert.equal(call({ ...several, prompt: "another words" }), undefined, "it is the pictures that were approved");
    assert.equal(call(several)?.block, true, "and once");
    assert.equal(call({ paths: ["shared/logo.png"], prompt: "p" })?.block, true, "not for fewer or other pictures");

    // The path the agent would write for one picture works for a list of one, as for the tool's other shape.
    const row = askQuestion({ sessionId: session, personKey: "priya", personName: "Priya", channelSlug: "chat", channelKey: "k", question: "may I?", actionTool: "edit_image", action: "shared/a.png" });
    recordApproval(readAnswer(`#${row.id} approve`)!.question, { id: session }, true, false);
    assert.equal(call({ paths: ["shared/a.png"], prompt: "p" }), undefined);
    const again = askQuestion({ sessionId: session, personKey: "priya", personName: "Priya", channelSlug: "chat", channelKey: "k", question: "may I?", actionTool: "edit_image", action: "shared/a.png" });
    recordApproval(readAnswer(`#${again.id} approve`)!.question, { id: session }, true, false);
    assert.equal(call({ path: "shared/a.png", prompt: "p" }), undefined, "and for one path");

    // Always: one rule for each picture, for her alone, which lets the same call through every time and nothing else.
    approve(call(several), "always");
    const made = listToolRules().filter((r) => r.tool === "edit_image" && r.person_key === "priya");
    assert.deepEqual(made.map((r) => r.pattern).sort(), ["Summer, banner.png", "shared/logo.png"], "a rule that held both would match neither");
    assert.equal(call(several), undefined);
    assert.equal(call(several), undefined, "not spent");
    assert.equal(call({ paths: ["Summer, banner.png"], prompt: "p" }), undefined, "each picture is allowed on its own now");
    assert.equal(call({ paths: ["shared/logo.png", "private.png"], prompt: "p" })?.block, true, "a picture that was not approved is not");
    // "Always" is also an approval of the call once, which her rules did not need and left open for this conversation: spent here.
    who = { role: "colleague", key: "sam" };
    assert.equal(call(several), undefined, "the one-off approval is the conversation's, whoever speaks");
    assert.equal(call(several)?.block, true, "the rules are Priya's alone");
  } finally {
    for (const r of listToolRules().filter((rule) => rule.tool === "edit_image")) deleteToolRule(r.id);
  }
});

test("the tool menus do not offer edit_image while editing is off, though it is remembered for when it is on", async () => {
  const { remembered, rememberTools, shownTools, knownTools } = await import("../server/src/db.ts");
  rememberTools([
    remembered({ name: "edit_image", source: "image-editing", inline: true }),
    remembered({ name: "generate_image", source: "image-generation", inline: true }),
    remembered({ name: "show_image", source: "pictures", inline: true }),
  ]);
  const names = () => shownTools().map((t) => t.name).filter((n) => /image/.test(n)).sort();
  reset();
  assert.deepEqual(names(), ["show_image"]);
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true });
  assert.deepEqual(names(), ["edit_image", "show_image"], "editing on, generation off: only its own tool");
  gen.saveImageGeneration({ enabled: true });
  assert.deepEqual(names(), ["edit_image", "generate_image", "show_image"]);
  gen.saveImageGeneration({ editEnabled: false });
  assert.deepEqual(names(), ["generate_image", "show_image"]);
  assert.equal(knownTools().find((t) => t.name === "edit_image")?.inline, true, "remembered for when it is on");

  // An extension's tool of the same name is loaded whatever the add-on says, so it is offered.
  rememberTools([remembered({ name: "edit_image", source: "image-package" })]);
  assert.deepEqual(names(), ["edit_image", "generate_image", "show_image"]);
  rememberTools([remembered({ name: "edit_image", source: "image-editing", inline: true })]);
  assert.deepEqual(names(), ["generate_image", "show_image"]);
  reset();
});

test("an extension's edit_image is the one pi keeps, so the portal's is not counted as there", () => {
  const ext = (extensionPath: string, ...names: string[]) => ({ path: extensionPath, tools: new Map(names.map((n) => [n, { definition: { name: n } }])) });
  const own = ext("<inline:image-editing>", "edit_image");
  reset();
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true });
  let loaded: any[] = [own];
  const tool = new EditImageTool(mkdtempSync(path.join(temp, "chat-")), () => loaded);
  assert.equal(tool.registered(), false, "not before it is loaded");
  tool.extension({ registerTool: () => {} });
  assert.equal(tool.registered(), true);
  loaded = [ext("/x/image-package.ts", "edit_image"), own];
  assert.equal(tool.registered(), false, "an extension's tool is the model's");
  loaded = [ext("/x/image-package.ts", "generate_image"), own];
  assert.equal(tool.registered(), true, "another name is no clash: the generation tool is not this one");
  reset();
});

test("the API saves the time limit and refuses one out of bounds, without reloading chats", async () => {
  const express = (await import("express")).default;
  const { featuresRouter } = await import("../server/src/api/features.ts");
  const app = express().use(express.json()).use("/api", featuresRouter());
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${at}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    reset();
    assert.equal((await call("GET", "/features/images")).body.images.timeoutSeconds, 300, "five minutes by default");
    assert.equal((await call("GET", "/features")).body.images.timeoutSeconds, 300);
    const saved = await call("PUT", "/features/images", { timeoutSeconds: 600 });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { images: fresh({ timeoutSeconds: 600 }), changed: false, reloaded: 0, waiting: 0 });
    for (const bad of [10, 4000, 1.5, "600"]) {
      const refused = await call("PUT", "/features/images", { timeoutSeconds: bad });
      assert.equal(refused.status, 400, String(bad));
      assert.match(refused.body.error, /from 30 to 3600/);
    }
    assert.equal((await call("GET", "/features/images")).body.images.timeoutSeconds, 600, "a refused one changes nothing");
  } finally {
    portal.close();
    reset();
  }
});

// --- the maximum size of an edit ---

/** A picture of this many pixels, as far as its header says: the rest is padding. */
const pngOf = (w: number, h: number) => {
  const dim = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), dim(w), dim(h), Buffer.alloc(16)]);
};

test("the maximum size of an edit is saved as the size of generation is written, and is none until chosen", () => {
  const parse = gen.parseImageGenerationPatch;
  assert.deepEqual(parse({ editMaxSize: " 2048x1024 " }), { editMaxSize: "2048x1024" });
  assert.deepEqual(parse({ editMaxSize: "" }), { editMaxSize: "" }, "emptied is no limit");
  for (const bad of ["auto", "2048", "2048*1024", "big", "1x1", "123456x10", "00x00", "0x2048", "2048x00", "02048x2048", 2048, null]) {
    assert.match(String(parse({ editMaxSize: bad })), /maximum size looks like/, String(bad));
  }

  reset();
  assert.equal(gen.imageGenerationConfig().editMaxSize, "", "a fresh install has none");
  assert.equal(gen.imageGenerationState().editMaxSize, "");
  assert.equal(gen.imageEditingTarget().maxSize, "");
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1", editEnabled: true, editMaxSize: "2048x1024" });
  assert.equal(gen.imageGenerationConfig().editMaxSize, "2048x1024");
  assert.equal(gen.imageGenerationState().editMaxSize, "2048x1024");
  assert.equal(gen.imageEditingTarget().maxSize, "2048x1024");
  assert.equal(gen.imageGenerationConfig().size, "", "generation's own size is another setting");
  gen.saveImageGeneration({ model: "other" });
  assert.equal(gen.imageGenerationConfig().editMaxSize, "2048x1024", "another change leaves it");
  gen.saveImageGeneration({ editMaxSize: "" });
  assert.equal(gen.imageEditingTarget().maxSize, "", "taken away");

  // A setup saved before there was a maximum has none; one that cannot be read is as good as none.
  putSetting("image_generation", JSON.stringify({ enabled: true, baseUrl: "https://images.example.com/v1", editEnabled: true }));
  assert.equal(gen.imageGenerationConfig().editMaxSize, "");
  assert.equal(gen.imageGenerationConfig().baseUrl, "https://images.example.com/v1", "the rest of an old setup is read as it was");
  for (const bad of [2048, "auto", "wide", null, ["2048x2048"]]) {
    putSetting("image_generation", JSON.stringify({ editMaxSize: bad }));
    assert.equal(gen.imageGenerationConfig().editMaxSize, "", `stored ${JSON.stringify(bad)}`);
  }
  reset();
});

/** A real picture: solid colour (light as a file) or noise (heavy as a file, and what the byte limits are tested with). */
const real = (width: number, height: number, how: { noise?: boolean; alpha?: boolean; format?: "png" | "jpeg" | "webp" | "gif"; orientation?: number } = {}) => {
  const channels = how.alpha ? 4 : 3;
  const image = sharp({
    create: { width, height, channels, background: { r: 200, g: 40, b: 40, alpha: how.alpha ? 0.5 : 1 }, ...(how.noise ? { noise: { type: "gaussian" as const, mean: 128, sigma: 60 } } : {}) },
  });
  const tagged = how.orientation ? image.withMetadata({ orientation: how.orientation }) : image;
  switch (how.format ?? "png") {
    case "jpeg": return tagged.jpeg().toBuffer();
    case "webp": return tagged.webp().toBuffer();
    case "gif": return tagged.gif().toBuffer();
    default: return tagged.png().toBuffer();
  }
};
const sentImages = (seen: Seen) => partList(seen).filter((part) => part.name === "image" || part.name === "image[]");
const dimensions = async (bytes: Buffer) => {
  const { width, height } = await sharp(bytes).metadata();
  return `${width}x${height}`;
};

test("an edit beyond the maximum size is scaled down to fit, keeping its ratio, and goes ahead", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    const limited = target(origin, { maxSize: "2048x1024", multiple: true });
    const edit = async (image: Buffer | Buffer[], mask?: Buffer) => {
      const before = seen.length;
      const result = await editing.editImage(limited, { prompt: "p", image, mask });
      assert.equal(seen.length, before + 1, "the edit was sent, not refused");
      return { sent: sentImages(seen.at(-1)!), result };
    };
    // Either way up: the box fits a portrait picture as it fits a landscape one. 4096x2048 halves; 1000x4000 is 512x2048 (the box on its side).
    for (const [from, to] of [["4096x2048", "2048x1024"], ["2049x1024", "2048x1023"], ["3000x3000", "1024x1024"], ["1000x4000", "512x2048"], ["1024x2049", "1023x2048"]]) {
      const [w, h] = from.split("x").map(Number);
      const { sent, result } = await edit(await real(w, h));
      assert.equal(await dimensions(sent[0].bytes), to, `${from} is scaled to ${to}`);
      assert.match(result.notes[0], new RegExp(`^The image was scaled down from ${from} pixels .* to ${to} pixels`));
    }
    // Never up, and a picture that fits is sent byte for byte.
    for (const fits of [await real(2048, 1024), await real(1024, 2048), await real(10, 10), await real(1500, 700, { format: "jpeg" })]) {
      const { sent, result } = await edit(fits);
      assert.deepEqual(sent[0].bytes, fits);
      assert.deepEqual(result.notes, []);
    }
    // Each kind stays what it was, and transparency stays.
    for (const [format, type] of [["jpeg", "image/jpeg"], ["webp", "image/webp"], ["gif", "image/gif"], ["png", "image/png"]] as const) {
      const { sent } = await edit(await real(4096, 2048, { format, alpha: format === "png" || format === "webp" }));
      assert.equal(sent[0].type, type);
      assert.equal(await dimensions(sent[0].bytes), "2048x1024");
      if (format === "png" || format === "webp") assert.equal((await sharp(sent[0].bytes).metadata()).hasAlpha, true, `${format} keeps its alpha`);
    }
    // A picture a camera held on its side is scaled as it is seen, not as it is stored.
    const turned = await edit(await real(4000, 2000, { format: "jpeg", orientation: 6 }));
    assert.equal(await dimensions(turned.sent[0].bytes), "1024x2048", "stored 4000x2000, seen 2000x4000");
    // Several: the ones that fit are untouched, in the order given.
    const small = await real(100, 100);
    const several = await edit([small, await real(5000, 500)]);
    assert.deepEqual(several.sent[0].bytes, small);
    assert.equal(await dimensions(several.sent[1].bytes), "2048x204");
    assert.equal(several.result.notes.length, 1);
    assert.match(several.result.notes[0], /^Picture 2 was scaled down from 5000x500/);
  } finally {
    server.close();
  }
});

test("a mask is scaled with its picture to the same size, and stays a mask", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    const limited = target(origin, { maxSize: "2048x1024" });
    // Black on the left and white on the right, the edge at an odd place: smoothing would make it grey there.
    const width = 4001;
    const height = 2000;
    const raw = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) raw.fill(255, y * width + 1999, (y + 1) * width);
    const mask = await sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
    await editing.editImage(limited, { prompt: "p", image: await real(width, height), mask });
    const parts = partList(seen[0]);
    const image = parts.find((part) => part.name === "image")!;
    const sentMask = parts.find((part) => part.name === "mask")!;
    assert.equal(await dimensions(sentMask.bytes), await dimensions(image.bytes), "the same size as the picture");
    assert.equal(await dimensions(image.bytes), "2048x1023", "4001x2000 within 2048x1024, the ratio kept");
    const values = new Set(await sharp(sentMask.bytes).greyscale().raw().toBuffer());
    assert.deepEqual([...values].sort((a, b) => a - b), [0, 255], "no grey where black meets white");

    // A mask of a size of its own is left to the endpoint, as it always was: it is not made to match.
    await editing.editImage(limited, { prompt: "p", image: await real(4000, 2000), mask: await real(64, 64) });
    assert.equal(await dimensions(partList(seen[1]).find((part) => part.name === "mask")!.bytes), "64x64");
    // A picture that fits is sent as it is, mask and all.
    const fitting = await real(800, 600);
    const fittingMask = await real(800, 600, { alpha: true });
    await editing.editImage(limited, { prompt: "p", image: fitting, mask: fittingMask });
    assert.deepEqual(partList(seen[2]).filter((part) => part.name === "image" || part.name === "mask").map((part) => part.bytes), [fitting, fittingMask]);
  } finally {
    server.close();
  }
});

test("a picture over the byte limits is made lighter in proportion, keeping its ratio and its transparency, and goes ahead", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    const several = target(origin, { multiple: true });
    const heavy = await real(700, 500, { noise: true });
    assert.ok(heavy.length > 400 * 1024, `the noise is heavy (${heavy.length} bytes)`);
    const limit = 120 * 1024;
    const one = await editing.editImage(several, { prompt: "p", image: heavy }, { maxInputBytes: limit });
    const [sent] = sentImages(seen[0]);
    assert.ok(sent.bytes.length <= limit, `now ${sent.bytes.length} bytes`);
    assert.equal(sent.type, "image/jpeg", "a PNG without transparency is a JPEG when it has to be lighter");
    assert.equal(sent.filename, "image.jpg");
    const { width, height } = await sharp(sent.bytes).metadata();
    assert.ok(Math.abs(width! / height! - 700 / 500) < 0.03, `the ratio of 700x500 is kept: ${width}x${height}`);
    assert.match(one.notes[0], /^The image was (scaled down from 700x500 pixels|compressed from)/);

    // With transparency it is a WebP, which has some, and the transparency is still there.
    const see = await real(600, 400, { noise: true, alpha: true });
    await editing.editImage(several, { prompt: "p", image: see }, { maxInputBytes: 100 * 1024 });
    const [lighter] = sentImages(seen[1]);
    assert.equal(lighter.type, "image/webp");
    assert.ok(lighter.bytes.length <= 100 * 1024);
    assert.equal((await sharp(lighter.bytes).metadata()).hasAlpha, true);

    // Together: pictures that are each fine share what is allowed, and the light one is left alone.
    const light = await real(50, 50);
    const [a, b] = [await real(500, 500, { noise: true }), await real(500, 500, { noise: true })];
    const total = 150 * 1024;
    assert.ok(a.length + b.length + light.length > total);
    const together = await editing.editImage(several, { prompt: "p", image: [a, light, b] }, { maxTotalBytes: total });
    const sentTogether = sentImages(seen[2]);
    assert.deepEqual(sentTogether[1].bytes, light, "the light one is sent as it is");
    assert.ok(sentTogether.reduce((sum, part) => sum + part.bytes.length, 0) <= total);
    assert.deepEqual(together.notes.map((note) => note.slice(0, 9)), ["Picture 1", "Picture 3"]);
  } finally {
    server.close();
  }
});

test("a large PNG with a tight budget is shrunk from what its lossy copy weighs, ending near the budget", async () => {
  const { fitBytes } = await import("../server/src/picture-scale.ts");
  const big = await real(2000, 1500, { noise: true });
  const budget = 350 * 1024;
  assert.ok(big.length > 20 * budget, `the original is far heavier than the budget (${big.length} bytes)`);
  const out = await fitBytes(big, budget);
  assert.ok(out.bytes.length <= budget, `now ${out.bytes.length} bytes`);
  // The original's weight would have sent the first factor to the 0.3 floor (600x450, about 20 KB).
  assert.ok(out.size.width >= 1000, `not shrunk to the floor: ${out.size.width}x${out.size.height}`);
  assert.ok(out.bytes.length > budget / 3, `near the budget, not far under it: ${out.bytes.length} bytes`);
});

test("a picture that cannot be made to fit is refused with a message, and nothing is sent", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    const limited = target(origin, { maxSize: "2048x1024", multiple: true });
    const refused = (request: Parameters<typeof editing.editImage>[1], message: RegExp, options = {}) =>
      assert.rejects(editing.editImage(limited, request, options), (e: Error) => {
        assert.ok(e instanceof gen.ImageGenerationError);
        assert.match(e.message, message);
        assert.match(e.message, /Nothing was sent/);
        return true;
      });
    // Too heavy at any size it may be: a few bytes cannot hold a picture.
    await refused({ prompt: "p", image: await real(600, 400, { noise: true }) }, /^The image cannot be made to fit an edit: it stays too heavy even when it is scaled down and compressed as far as it can be\./, { maxInputBytes: 200 });
    await refused({ prompt: "p", image: [await real(600, 400, { noise: true }), await real(600, 400, { noise: true })] }, /^Picture 1 cannot be made to fit an edit/, { maxTotalBytes: 300 });
    // Over the maximum size but no picture that can be read; one with no size to read at all.
    await refused({ prompt: "p", image: pngOf(3000, 3000) }, /^The image cannot be made to fit an edit: it cannot be read as a picture/);
    await refused({ prompt: "p", image: PNG }, /^The image has a size that cannot be read.*maximum of 2048x1024.*Settings → Agent → Media/);
    await refused({ prompt: "p", image: Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xe0]) }, /^The image has a size that cannot be read/);
    // One refused refuses all, with its place.
    await refused({ prompt: "p", image: [await real(100, 100), await real(5000, 500), PNG] }, /^Picture 3 has a size that cannot be read/);
    assert.equal(seen.length, 0, "no request reached the endpoint");

    // None set: any size goes, as it did, unread.
    await editing.editImage(target(origin), { prompt: "p", image: pngOf(9000, 9000) });
    await editing.editImage(target(origin), { prompt: "p", image: PNG });
    assert.equal(seen.length, 2);
  } finally {
    server.close();
  }
});

test("edit_image scales a picture beyond the maximum size down, says so in its answer, and keeps the original", async () => {
  const wide = await real(4000, 500);
  const folder = chatWith({ "small.png": await real(512, 512), "wide.png": wide, "tall.png": await real(300, 3000) });
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(JPEG) }] }));
  try {
    reset();
    gen.saveImageGeneration({ baseUrl: origin, editEnabled: true, editMultiple: true, editMaxSize: "2048x2048" });
    const { call } = loadEdit(folder);
    const one = await call({ path: "wide.png", prompt: "p" });
    assert.equal(seen.length, 1, "sent");
    assert.equal(await dimensions(sentImages(seen[0])[0].bytes), "2048x256");
    assert.match(one.content[0].text, /^Edited wide\.png, and shown to the user: generated-images\/wide-edited\.jpg\. The image was scaled down from 4000x500 pixels \(.*\) to 2048x256 pixels \(.*\) to fit what an edit takes\. The result is not scaled back up\.$/);
    assert.deepEqual(readFileSync(path.join(folder, "wide.png")), wide, "the original is as it was");

    // Several: the one over the box is named by its place.
    const two = await call({ paths: ["small.png", "tall.png"], prompt: "p" });
    assert.equal(await dimensions(sentImages(seen[1])[1].bytes), "204x2048");
    assert.match(two.content[0].text, /^Made from small\.png, tall\.png \(in this order\), and shown to the user: .*\. Picture 2 was scaled down from 300x3000/);

    // A picture within the limit has nothing added to its answer.
    assert.match((await call({ path: "small.png", prompt: "p" })).content[0].text, /^Edited small\.png, and shown to the user: generated-images\/small-edited \(2\)\.jpg$/);
    // The limit is read at each call: raised, the same picture goes as it is.
    gen.saveImageGeneration({ editMaxSize: "4096x4096" });
    await call({ path: "wide.png", prompt: "p" });
    assert.deepEqual(sentImages(seen.at(-1)!)[0].bytes, wide);
  } finally {
    server.close();
    reset();
  }
});

test("the API saves the maximum size of an edit and refuses one that is no size, without reloading chats", async () => {
  const express = (await import("express")).default;
  const { featuresRouter } = await import("../server/src/api/features.ts");
  const app = express().use(express.json()).use("/api", featuresRouter());
  const portal = app.listen(0, "127.0.0.1");
  await new Promise((r) => portal.once("listening", r));
  const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${at}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    reset();
    assert.equal((await call("GET", "/features/images")).body.images.editMaxSize, "", "none by default");
    const saved = await call("PUT", "/features/images", { editMaxSize: "2048x2048" });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { images: fresh({ editMaxSize: "2048x2048" }), changed: false, reloaded: 0, waiting: 0 });
    assert.equal((await call("GET", "/features")).body.images.editMaxSize, "2048x2048");
    const refused = await call("PUT", "/features/images", { editMaxSize: "huge" });
    assert.equal(refused.status, 400);
    assert.equal((await call("GET", "/features/images")).body.images.editMaxSize, "2048x2048", "a refused one changes nothing");
    assert.equal((await call("PUT", "/features/images", { editMaxSize: "" })).body.images.editMaxSize, "");
  } finally {
    portal.close();
    reset();
  }
});

test("the agent's tools send nothing that only stable-diffusion.cpp reads, with the Stable Diffusion switch on or off", async () => {
  const { origin, seen, server } = await fake((_req, res) => json(res, { data: [{ b64_json: b64(PNG) }] }));
  try {
    for (const sdExtras of [false, true]) {
      reset();
      gen.saveImageGeneration({ baseUrl: origin, enabled: true, editEnabled: true, sdExtras });
      const folder = chatWith();
      const make = load(folder);
      const change = loadEdit(folder);
      // They have no such settings to give, and the switch does not give them any.
      assert.deepEqual(Object.keys(make.registered[0].parameters.properties).sort(), ["prompt", "size", "title"]);
      assert.ok(!Object.keys(change.registered[0].parameters.properties).some((name) => /seed|steps|negative|strength|noise|init/i.test(name)));
      const before = seen.length;
      await make.call({ prompt: "a lighthouse at dusk" });
      await change.call({ prompt: "make it night", path: "photo.png" });
      assert.equal(seen.length, before + 2);
      assert.equal(seen[before].body.prompt, "a lighthouse at dusk", `generation, switch ${sdExtras}`);
      assert.equal(parts(seen[before + 1]).prompt.bytes.toString(), "make it night", `editing, switch ${sdExtras}`);
    }
    assert.ok(seen.every((one) => !one.raw!.includes("sd_cpp_extra_args")));
  } finally {
    server.close();
    reset();
  }
});

test("the Stable Diffusion switch is off in a setup saved without it, is a plain true or false, and is the person's to change", () => {
  reset();
  putSetting("image_generation", JSON.stringify({ enabled: true, baseUrl: "https://images.example.com/v1", editEnabled: true }));
  assert.equal(gen.imageGenerationConfig().sdExtras, false);
  assert.equal(gen.imageEditingTarget().sdExtras, false);
  assert.equal(gen.imageGenerationState().sdExtras, false);
  for (const bad of ["yes", 1, null, "true"]) assert.match(String(gen.parseImageGenerationPatch({ sdExtras: bad })), /sdExtras must be true or false/, String(bad));
  assert.deepEqual(gen.parseImageGenerationPatch({ sdExtras: true }), { sdExtras: true });
  gen.saveImageGeneration({ sdExtras: true });
  assert.equal(gen.imageGenerationConfig().sdExtras, true);
  assert.equal(gen.imageEditingTarget().sdExtras, true);
  assert.equal(gen.imageGenerationConfig().baseUrl, "https://images.example.com/v1", "the rest is as it was");
  putSetting("image_generation", JSON.stringify({ sdExtras: "true" }));
  assert.equal(gen.imageGenerationConfig().sdExtras, false, "only a true is on");
  reset();
});
