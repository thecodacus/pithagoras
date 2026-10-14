import { test, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The edit_image tool as pi runs it: a model that calls it, an endpoint that
 * answers, and what the chat sees come back. Registered through the portal's
 * own client, so the tool's parameters are checked by pi as they are for a
 * real model.
 */
const home = inProcessHome("pithagoras-edit-image-");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)]);

/** What the model does at its next request: the arguments of a call to `named`, edit_image unless a test says another. */
let call;
let named = "edit_image";
/** The tools each request offered, by name, and as the model got them. */
const offered = [];
const definitions = [];
const model = await fakeModel((request) => {
  offered.push((request.tools ?? []).map((t) => t.function?.name));
  definitions.push(request.tools ?? []);
  // A call first; once its result is in the conversation, an answer.
  return resultsIn(request) > 0 ? "Done." : { name: named, args: call };
});

/** The image endpoint: what it was asked, and what it answers with. */
const asked = [];
let answer = { status: 200, body: () => ({ data: [{ b64_json: JPEG.toString("base64") }] }) };
const endpoint = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    asked.push({ url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks) });
    // Only a picture to be made or edited is asked of it: any other call is a mistake, and not a picture.
    if (req.method !== "POST" || !["/v1/images/edits", "/v1/images/generations"].includes(req.url)) return void res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: `no ${req.method} ${req.url} here` } }));
    res.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify(answer.body()));
  });
});
endpoint.listen(0, "127.0.0.1");
await once(endpoint, "listening");
after(() => endpoint.close());

writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { saveImageGeneration } = await import("../dist/image-generation.js");

/** The start of every call the runs saw, as the chat is told of it. */
const started = [];

/** One message to a conversation in `folder`, and the results of the tool calls it led to. */
async function run(folder, options = {}) {
  const client = await SdkPiClient.create({
    cwd: folder, sessionDir: mkdtempSync(path.join(home, "chat-")), provider: "fake", modelId: "m", sessionId: `edit-${path.basename(folder)}`, ...options,
  });
  const results = [];
  const settled = new Promise((resolve) => client.on("event", (e) => {
    if (e?.type === "tool_execution_start") started.push(e);
    if (e?.type === "tool_execution_end") results.push(e);
    if (e?.type === "agent_settled") resolve();
  }));
  try {
    await client.prompt("Change the picture");
    await settled;
    return results;
  } finally {
    client.dispose();
  }
}

const chat = () => {
  const folder = mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-"));
  writeFileSync(path.join(folder, "photo.png"), PNG);
  return folder;
};

test("a model that calls edit_image gets a new picture in the chat's folder, shown as a generated one is", async () => {
  const folder = chat();
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "sk-test-1", editEnabled: true, editModel: "edit-model" });
  try {
    call = { path: "photo.png", prompt: "make it red", title: "Red" };
    const [result, ...more] = await run(folder);
    assert.equal(more.length, 0);
    assert.ok(offered.at(-1).includes("edit_image") && !offered.at(-1).includes("generate_image"), "the edit tool alone is offered");
    assert.equal(result.isError, false);
    // The start of the call already says it is the portal's own: the chat draws its picture from then on, and a call that fails or is cut off never says it at its end.
    assert.equal(started.at(-1).toolName, "edit_image");
    assert.equal(started.at(-1).portalImage, true);
    assert.deepEqual(result.result.details, { path: "generated-images/photo-edited.jpg", title: "Red", portalImage: true });
    assert.deepEqual(readFileSync(path.join(folder, "generated-images", "photo-edited.jpg")), JPEG);
    assert.deepEqual(readFileSync(path.join(folder, "photo.png")), PNG, "the original stays");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, "/v1/images/edits");
    assert.equal(asked[0].auth, "Bearer sk-test-1");
    assert.match(asked[0].type, /^multipart\/form-data/);
    assert.ok(asked[0].body.includes(PNG), "the picture's bytes went with it");
    assert.ok(asked[0].body.includes("make it red") && asked[0].body.includes("edit-model"));
  } finally {
    saveImageGeneration({ baseUrl: "", apiKey: "", editEnabled: false, editModel: "" });
  }
});

test("an edit_image that is lazy is the portal's own to the chat as well: its start says so, and its end which tool it was", async () => {
  const folder = chat();
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, editEnabled: true, editModel: "edit-model" });
  named = "tools";
  try {
    call = { action: "call", name: "edit_image", args: { path: "photo.png", prompt: "make it red", title: "Red" } };
    const [result, ...more] = await run(folder, { toolsLazy: ["edit_image"] });
    assert.equal(more.length, 0);
    assert.ok(!offered.at(-1).includes("edit_image") && offered.at(-1).includes("tools"), "it is reached through the gateway");
    assert.equal(result.isError, false);
    assert.equal(started.at(-1).toolName, "tools");
    assert.equal(started.at(-1).portalImage, true, "the start says the call is of the portal's tool, as a direct call's does");
    assert.equal(result.portalCalledTool, "edit_image");
    assert.deepEqual(result.result.details, { path: "generated-images/photo-edited.jpg", title: "Red", portalImage: true });
  } finally {
    named = "edit_image";
    saveImageGeneration({ baseUrl: "", apiKey: "", editEnabled: false, editModel: "" });
  }
});

test("an edit that fails is an error the model sees, and leaves nothing in the chat's folder", async () => {
  const folder = chat();
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, editEnabled: true });
  answer = { status: 400, body: () => ({ error: { message: "This model cannot edit pictures" } }) };
  try {
    call = { path: "photo.png", prompt: "make it red" };
    const [result] = await run(folder);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.result), /answered 400: This model cannot edit pictures/);
    assert.deepEqual(readdirSync(folder), ["photo.png"]);

    // A picture that is not one of the chat's folder never reaches the endpoint.
    answer = { status: 200, body: () => ({ data: [{ b64_json: JPEG.toString("base64") }] }) };
    const before = asked.length;
    call = { path: "/etc/hostname", prompt: "make it red" };
    const [outside] = await run(chat());
    assert.equal(outside.isError, true);
    assert.equal(asked.length, before, "nothing was sent");
    // Arguments that do not fit the tool's parameters are pi's to refuse.
    call = { prompt: "make it red" };
    const [bad] = await run(chat());
    assert.equal(bad.isError, true);
    assert.equal(asked.length, before);
  } finally {
    saveImageGeneration({ baseUrl: "", apiKey: "", editEnabled: false });
    answer = { status: 200, body: () => ({ data: [{ b64_json: JPEG.toString("base64") }] }) };
  }
});

test("with editing off there is no tool for the model to call", async () => {
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, enabled: false, editEnabled: false });
  try {
    const folder = chat();
    call = { path: "photo.png", prompt: "x" };
    await run(folder).catch(() => {});
    assert.ok(!offered.at(-1).includes("edit_image"));
    assert.ok(!existsSync(path.join(folder, "generated-images")));
  } finally {
    saveImageGeneration({ baseUrl: "" });
  }
});

test("with several pictures switched on the model gets a list, pi holds it to its bounds, and the endpoint gets them all in order", async () => {
  const folder = chat();
  writeFileSync(path.join(folder, "style.jpg"), JPEG);
  writeFileSync(path.join(folder, "pattern.gif"), GIF);
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, editEnabled: true, editMultiple: true });
  try {
    call = { paths: ["photo.png", "style.jpg", "pattern.gif"], prompt: "the first, painted like the second, on the third", title: "Painted" };
    const before = asked.length;
    const [result, ...more] = await run(folder);
    assert.equal(more.length, 0);
    const tool = definitions.at(-1).find((t) => t.function?.name === "edit_image").function;
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["paths", "prompt", "title"], "the model is given a list, not a path");
    assert.equal(tool.parameters.properties.paths.type, "array");
    assert.equal(result.isError, false);
    assert.deepEqual(result.result.details, { path: "generated-images/photo-edited.jpg", title: "Painted", portalImage: true });
    assert.deepEqual(readFileSync(path.join(folder, "generated-images", "photo-edited.jpg")), JPEG);
    assert.equal(asked.length, before + 1, "one request");
    const body = asked.at(-1).body;
    const at = (bytes) => body.indexOf(bytes);
    assert.ok(at(PNG) >= 0 && at(PNG) < at(JPEG) && at(JPEG) < at(GIF), "the three pictures, in the order of the list");
    assert.equal(body.toString("latin1").split('name="image[]"').length - 1, 3, "each as image[]");
    assert.ok(body.includes("the first, painted like the second, on the third"));

    // pi holds the call to the list's bounds before the tool sees it: none, or more than an edit takes, never reach the endpoint.
    for (const paths of [[], Array(9).fill("photo.png")]) {
      call = { paths, prompt: "x" };
      const [bad] = await run(chat());
      assert.equal(bad.isError, true, JSON.stringify(paths));
      assert.equal(asked.length, before + 1, "nothing was sent");
    }
    // And a path alone is not the shape that was offered.
    call = { path: "photo.png", prompt: "x" };
    assert.equal((await run(chat()))[0].isError, true);
    assert.equal(asked.length, before + 1);
  } finally {
    saveImageGeneration({ baseUrl: "", apiKey: "", editEnabled: false, editMultiple: false });
  }
});

test("with it off the model gets one path, and a list of several is not something it can send", async () => {
  const folder = chat();
  writeFileSync(path.join(folder, "style.jpg"), JPEG);
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, editEnabled: true, editMultiple: false });
  try {
    call = { paths: ["photo.png", "style.jpg"], prompt: "x" };
    const before = asked.length;
    const [result] = await run(folder);
    const tool = definitions.at(-1).find((t) => t.function?.name === "edit_image").function;
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["path", "prompt", "title"]);
    assert.equal(result.isError, true, "no path: pi refuses it");
    assert.equal(asked.length, before, "nothing was sent");
    assert.deepEqual(readdirSync(folder).sort(), ["photo.png", "style.jpg"]);
    call = { path: "photo.png", prompt: "x" };
    assert.equal((await run(folder))[0].isError, false, "one picture is as it was");
  } finally {
    saveImageGeneration({ baseUrl: "", apiKey: "", editEnabled: false });
  }
});

test("the start of a call is the portal's own for its tools, and is not for a tool of the same name that an extension brings", async () => {
  const extensions = path.join(process.env.PI_CODING_AGENT_DIR, "extensions");
  mkdirSync(extensions, { recursive: true });
  const theirs = path.join(extensions, "pictures.ts");
  // The extension that has the names: pi keeps its tools, and the portal's are left unused.
  writeFileSync(theirs, `export default function (pi: any) {
  for (const name of ["generate_image", "edit_image"]) {
    pi.registerTool({
      name, label: name, description: "An extension's own picture tool.",
      parameters: { type: "object", properties: { prompt: { type: "string" } } },
      execute: async () => ({ content: [{ type: "text", text: "Saved /out/cat.png" }], details: {} }),
    });
  }
}
`);
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, editEnabled: true });
  try {
    for (const tool of ["generate_image", "edit_image"]) {
      named = tool;
      call = { path: "photo.png", prompt: "a cat" };
      const before = started.length;
      const [result] = await run(chat());
      assert.equal(result.isError, false, tool);
      assert.equal(started.length, before + 1, tool);
      assert.equal(started.at(-1).toolName, tool);
      assert.equal(started.at(-1).portalImage, undefined, `${tool}: the extension's, so not the portal's`);
      assert.match(JSON.stringify(result.result), /Saved \/out\/cat\.png/, "pi ran the extension's tool");
    }
  } finally {
    named = "edit_image";
    rmSync(theirs);
    saveImageGeneration({ baseUrl: "", apiKey: "", editEnabled: false });
  }

  // Without it, the portal's generation tool is the one that runs, and says so.
  saveImageGeneration({ baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, enabled: true });
  try {
    named = "generate_image";
    call = { prompt: "a cat" };
    const [result] = await run(chat());
    assert.equal(result.isError, false);
    assert.equal(started.at(-1).toolName, "generate_image");
    assert.equal(started.at(-1).portalImage, true);
  } finally {
    named = "edit_image";
    saveImageGeneration({ baseUrl: "", enabled: false });
  }
});
