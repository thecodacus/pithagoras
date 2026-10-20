import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startMedia } from "./portal.mts";
import * as gallery from "../src/server/image-gallery.ts";
import { getDb } from "../src/server/store.ts";

// The gallery lists the pictures that lie in the folders the agent's tools write into, recorded or not. A database from before it did, with its rows, is what these run on.
const temp = realpathSync(inProcessHome("pitha-folders-"));
const root = process.env.WORKSPACE_ROOT;
const home = process.env.AGENT_HOME;
mkdirSync(root, { recursive: true });

// The first bytes of each kind a browser draws, padded: that is all the check reads. `tag` tells two apart.
const pad = (head: number[] | Buffer, tag = "", to = 64) => Buffer.concat([Buffer.from(head), Buffer.from(tag), Buffer.alloc(to)]);
const png = (tag = "") => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], tag);
const jpeg = (tag = "") => pad([0xff, 0xd8, 0xff], tag);
const gif = (tag = "") => pad(Buffer.from("GIF89a"), tag);
const webp = (tag = "") => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(tag), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// The portal as it was before Media was an extension: its gallery table, as a released portal has it, and a picture of the page in it.
mkdirSync(path.join(temp, "images"), { recursive: true });
writeFileSync(path.join(temp, "images", "a1a1a1a1a1a1.png"), png("old"));
const legacy = new Database(path.join(temp, "portal.db"));
legacy.exec(`
  CREATE TABLE images (
    id TEXT PRIMARY KEY, origin TEXT NOT NULL, session_id TEXT, folder TEXT, path TEXT NOT NULL, kind TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}', source_id TEXT, bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_images_chat_file ON images(session_id, path) WHERE session_id IS NOT NULL;
`);
legacy.prepare("INSERT INTO images (id, origin, path, kind, prompt, bytes, created_at) VALUES ('a1a1a1a1a1a1', 'page', 'a1a1a1a1a1a1.png', 'generated', 'from before', 68, 1000)").run();
legacy.close();

// The portal opens it, upgraded, and Media takes up what it kept.
const media = await startMedia();
const { createAgent, deleteAgent } = await import("../../../core/server/dist/agents.js");
const { GENERATED_DIR } = gallery;
const at = media.at;
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${at}${p}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from(await r.arrayBuffer());
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers, bytes, body: type.includes("json") ? JSON.parse(bytes.toString("utf8")) : undefined };
};
const listed = async (query = "") => (await call("GET", `/images${query ? `${query}&` : "?"}limit=100`)).body;
const names = (list: any) => list.pictures.map((p: any) => p.fileName).sort();

/** A project: a folder under the workspace root, with a folder of generated pictures if asked. */
const project = (name: string, generated = true) => {
  const folder = path.join(root, name);
  mkdirSync(generated ? path.join(folder, GENERATED_DIR) : folder, { recursive: true });
  return folder;
};
/** A file in a folder's generated pictures, made at a time. */
const put = (folder: string, name: string, bytes: Buffer = png(name), time?: number) => {
  mkdirSync(path.join(folder, GENERATED_DIR), { recursive: true });
  const file = path.join(folder, GENERATED_DIR, name);
  writeFileSync(file, bytes);
  if (time !== undefined) utimesSync(file, time / 1000, time / 1000);
  return file;
};
const chatIn = (id: string, workspace: string, title = id) => media.chat(id, workspace, title);
const T = Date.UTC(2026, 0, 2, 12, 0, 0);

test("what the portal kept of the gallery is carried on, with its rows, and kept to one place for each file", async () => {
  const columns = (getDb().prepare("PRAGMA table_info(images)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("folder"));
  assert.deepEqual((getDb().prepare("SELECT id, prompt FROM images").all() as any[]).map((r) => r.prompt), ["from before"]);
  const row = (id: string) =>
    getDb().prepare("INSERT INTO images (id, origin, session_id, folder, path, kind, created_at) VALUES (?, 'folder', NULL, '/some/folder', 'generated-images/x.png', 'unknown', 1)").run(id);
  row("b1b1b1b1b1b1");
  assert.throws(() => row("b2b2b2b2b2b2"), /UNIQUE/, "the same file of the same folder is one picture");
  getDb().prepare("DELETE FROM images WHERE origin = 'folder'").run();
  const listing = await listed();
  assert.deepEqual(listing.pictures.map((p: any) => [p.id, p.origin, p.folder, p.prompt]), [["a1a1a1a1a1a1", "page", null, "from before"]]);
});

test("every picture in the folders the tools write into is listed, recorded or not, and nothing else is", async () => {
  const alpha = project("alpha");
  const gamma = project("gamma", false);
  const outside = path.join(temp, "outside");
  mkdirSync(path.join(outside, "pictures"), { recursive: true });
  writeFileSync(path.join(outside, "secret.png"), png("secret"));
  writeFileSync(path.join(outside, "pictures", "linked-dir.png"), png("linked-dir"));

  // What is a picture of the folder: by its bytes, whatever it is called, of each kind a browser draws.
  put(alpha, "image-20260102-120000-abc123.png", png("g"), T);
  put(alpha, "photo-edited.png", png("e"), T + 1000);
  put(alpha, "holiday.jpg", jpeg("j"), T + 2000);
  put(alpha, "movie.gif", gif("m"), T + 3000);
  put(alpha, "no extension", webp("w"), T + 4000);
  put(alpha, "disguised.txt", png("d"), T + 5000);
  put(alpha, "image-20260102-120500-aaa111-edited (2).png", png("ee"), T + 6000);
  // What is not: no picture by its bytes, an empty file, a hidden one (what is half written is called so), one too large for a picture.
  put(alpha, "notes.txt", Buffer.from("hello"));
  put(alpha, "fake.png", Buffer.from("<html><script>alert(1)</script></html>"));
  put(alpha, "vector.svg", SVG);
  put(alpha, "empty.png", Buffer.alloc(0));
  put(alpha, ".half-written.upload", png("half"));
  truncateSync(put(alpha, "huge.png", png("huge")), 26 * 1024 * 1024);
  // Links: one out of the folder to a picture, one to a picture in it, one to a folder with pictures.
  symlinkSync(path.join(outside, "secret.png"), path.join(alpha, GENERATED_DIR, "linked.png"));
  symlinkSync(path.join(alpha, GENERATED_DIR, "photo-edited.png"), path.join(alpha, GENERATED_DIR, "alias.png"));
  symlinkSync(path.join(outside, "pictures"), path.join(gamma, GENERATED_DIR));
  // Not where the tools write: beside the folder, below it, and in a folder of the workspace that no chat works in.
  writeFileSync(path.join(alpha, "loose.png"), png("loose"));
  mkdirSync(path.join(alpha, GENERATED_DIR, "sub"));
  writeFileSync(path.join(alpha, GENERATED_DIR, "sub", "deep.png"), png("deep"));
  put(path.join(alpha, "work"), "stray.png", png("stray"), T - 5000);
  // A chat's folder outside the workspace is not one either.
  const elsewhere = path.join(temp, "elsewhere");
  chatIn("chat-elsewhere", elsewhere);
  mkdirSync(elsewhere, { recursive: true });
  put(elsewhere, "image-20260102-110000-eee555.png", png("elsewhere"));
  // And Home, which every chat without a project works in.
  chatIn("chat-home", home, "In Home");
  put(home, "image-20260102-130000-def456.png", png("home"), T + 7000);
  // The folder of a chat that works in a folder of a project is looked in as well.
  chatIn("chat-work", path.join(alpha, "work"), "In work");

  const found = await listed("?origin=folder");
  assert.deepEqual(names(found), [
    "disguised.txt",
    "holiday.jpg",
    "image-20260102-120000-abc123.png",
    "image-20260102-120500-aaa111-edited (2).png",
    "image-20260102-130000-def456.png",
    "movie.gif",
    "no extension",
    "photo-edited.png",
    "stray.png",
  ]);
  assert.equal(found.total, 9);
  const by = (name: string) => found.pictures.find((p: any) => p.fileName === name);
  // The kind is told by the name the tools give: nothing else tells, and nothing is guessed.
  assert.equal(by("image-20260102-120000-abc123.png").kind, "generated");
  assert.equal(by("photo-edited.png").kind, "edited");
  assert.equal(by("image-20260102-120500-aaa111-edited (2).png").kind, "edited");
  for (const unknown of ["holiday.jpg", "movie.gif", "no extension", "disguised.txt", "stray.png"]) assert.equal(by(unknown).kind, "unknown", unknown);
  // Where it was found, which chat made it is not known, and nothing was asked of anybody.
  for (const p of found.pictures) {
    assert.equal(p.origin, "folder");
    assert.equal(p.chat, null);
    assert.equal(p.prompt, "");
    assert.deepEqual(p.params, {});
    assert.equal(p.from, null);
  }
  assert.deepEqual(by("holiday.jpg").folder, { name: "alpha", home: false });
  assert.deepEqual(by("stray.png").folder, { name: "alpha/work", home: false }, "the way to a folder a chat works in, under the root");
  // The first agent's home is named after the agent, as the sidebar names it (no SOUL.md here to name it otherwise).
  assert.deepEqual(by("image-20260102-130000-def456.png").folder, { name: "Agent", home: true });
  // When it was made is when its file was written, and what it weighs is what it does.
  assert.equal(by("image-20260102-120000-abc123.png").createdAt, T);
  assert.equal(by("movie.gif").bytes, gif("m").length);
  assert.equal(by("image-20260102-130000-def456.png").fileName, "image-20260102-130000-def456.png");
  // Newest first, with the page's own picture among them by its time.
  const everything = await listed();
  assert.equal(everything.total, 10);
  assert.equal(everything.pictures[0].fileName, "image-20260102-130000-def456.png");
  assert.equal(everything.pictures.at(-1).id, "a1a1a1a1a1a1");

  // Listed again, not listed again: the same pictures under the same ids, and nothing new is made of them.
  const ids = found.pictures.map((p: any) => p.id).sort();
  assert.deepEqual((await listed("?origin=folder")).pictures.map((p: any) => p.id).sort(), ids);
  assert.equal(gallery.scanFolders(), 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM images WHERE origin = 'folder'").get() as { n: number }).n, 9);

  // The filters know them.
  assert.equal((await listed("?origin=chat")).total, 0);
  assert.equal((await listed("?origin=page")).total, 1);
  assert.deepEqual(names(await listed("?kind=unknown")), ["disguised.txt", "holiday.jpg", "movie.gif", "no extension", "stray.png"]);
  assert.deepEqual(names(await listed("?origin=folder&kind=generated")), ["image-20260102-120000-abc123.png", "image-20260102-130000-def456.png"]);
  assert.deepEqual(names(await listed("?origin=folder&kind=edited")), ["image-20260102-120500-aaa111-edited (2).png", "photo-edited.png"]);
  assert.equal((await call("GET", "/images?kind=nice")).status, 400);
  assert.equal((await call("GET", "/images?origin=nowhere")).status, 400);
});

test("a picture that was found is shown and sent as any picture is, by its bytes, and is only ever read through its folder", async () => {
  const found = (await listed("?origin=folder")).pictures;
  const jpg = found.find((p: any) => p.fileName === "holiday.jpg");
  const shown = await call("GET", `/images/${jpg.id}/file`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/jpeg");
  assert.ok(shown.bytes.equals(jpeg("j")));
  assert.equal(shown.headers.get("cache-control"), "private, no-cache", "a file of a folder can change, unlike the page's own");
  // Called a text file, drawn as what it is.
  const disguised = found.find((p: any) => p.fileName === "disguised.txt");
  assert.equal((await call("GET", `/images/${disguised.id}/file`)).headers.get("content-type"), "image/png");
  assert.equal((await call("GET", `/images?ids=${jpg.id}`)).body.pictures[0].folder.name, "alpha");

  // Rows that name anything else are not served, whatever wrote them: a folder that is not Home or in the root, a path that leaves the folder, one that is not under the tools' folder.
  const row = (id: string, folder: string, rel: string) =>
    getDb().prepare("INSERT INTO images (id, origin, session_id, folder, path, kind, bytes, created_at) VALUES (?, 'folder', NULL, ?, ?, 'unknown', 70, ?)").run(id, folder, rel, T);
  writeFileSync(path.join(temp, "outside", "secret2.png"), png("secret2"));
  row("c1c1c1c1c1c1", path.join(temp, "outside"), "generated-images/secret.png");
  row("c2c2c2c2c2c2", path.join(root, "alpha"), "generated-images/../../outside/secret.png");
  row("c3c3c3c3c3c3", path.join(root, "alpha"), "loose.png");
  row("c4c4c4c4c4c4", path.join(root, "alpha"), "generated-images/linked.png");
  row("c5c5c5c5c5c5", temp, "generated-images/x.png");
  for (const id of ["c1c1c1c1c1c1", "c2c2c2c2c2c2", "c3c3c3c3c3c3", "c4c4c4c4c4c4", "c5c5c5c5c5c5"]) {
    const r = await call("GET", `/images/${id}/file`);
    assert.notEqual(r.status, 200, id);
    assert.ok(![png("secret"), png("secret2"), png("loose")].some((b) => r.bytes.equals(b)), `${id} gave a file from outside`);
  }
  // Nor is one of them listed again, and a delete takes nothing from anywhere else.
  const after = (await listed()).pictures.map((p: any) => p.id);
  for (const id of ["c1c1c1c1c1c1", "c2c2c2c2c2c2", "c3c3c3c3c3c3", "c4c4c4c4c4c4", "c5c5c5c5c5c5"]) assert.ok(!after.includes(id), `${id} is not listed`);
  for (const id of ["c1c1c1c1c1c1", "c2c2c2c2c2c2", "c3c3c3c3c3c3", "c4c4c4c4c4c4", "c5c5c5c5c5c5"]) await call("DELETE", `/images/${id}`);
  assert.equal(existsSync(path.join(temp, "outside", "secret.png")), true);
  assert.equal(existsSync(path.join(root, "alpha", "loose.png")), true);
});

test("a picture that was found and a picture that was recorded are one picture, whichever came first", async () => {
  const beta = project("beta");
  chatIn("chat-beta", beta, "Beta chat");
  // Found first: the page looks between the tool saving the file and saying so.
  const first = "image-20260102-140000-111111.png";
  put(beta, first, png("first"), T);
  const looked = (await listed("?origin=folder")).pictures.filter((p: any) => p.fileName === first);
  assert.equal(looked.length, 1);
  gallery.recordChatPicture({ sessionId: "chat-beta", path: `${GENERATED_DIR}/${first}`, kind: "generated", prompt: "a fox", params: { size: "512x512" }, bytes: 70 });
  const now = (await listed()).pictures.filter((p: any) => p.fileName === first);
  assert.equal(now.length, 1, "the same file is one entry");
  assert.equal(now[0].origin, "chat");
  assert.equal(now[0].prompt, "a fox");
  assert.deepEqual(now[0].chat, { id: "chat-beta", title: "Beta chat" });
  assert.equal(now[0].folder, null);
  assert.ok(!(await listed()).pictures.some((p: any) => p.id === looked[0].id), "the entry that was found is replaced");
  // Recorded first: nothing is made of it again.
  const second = "image-20260102-141000-222222.png";
  put(beta, second, png("second"), T + 1000);
  gallery.recordChatPicture({ sessionId: "chat-beta", path: `${GENERATED_DIR}/${second}`, kind: "generated", prompt: "a bear", params: {}, bytes: 70 });
  assert.equal(gallery.scanFolders(), 0);
  assert.equal((await listed()).pictures.filter((p: any) => p.fileName === second).length, 1);
  assert.equal((await listed("?origin=folder")).pictures.filter((p: any) => [first, second].includes(p.fileName)).length, 0);
  // An edit of a picture that was found is tied to it.
  const original = "shot.png";
  put(beta, original, png("shot"), T + 2000);
  const photo = (await listed("?origin=folder")).pictures.find((p: any) => p.fileName === original);
  put(beta, "shot-edited.png", png("shot-edited"), T + 3000);
  gallery.recordChatPicture({ sessionId: "chat-beta", path: `${GENERATED_DIR}/shot-edited.png`, kind: "edited", prompt: "night", params: {}, from: [`${GENERATED_DIR}/${original}`], bytes: 70 });
  const edit = (await listed("?kind=edited")).pictures.find((p: any) => p.fileName === "shot-edited.png");
  assert.equal(edit.from, photo.id);
  assert.deepEqual(edit.params.sources, [photo.id]);
  // A chat that goes leaves its pictures where they are, in a folder the page looks in: they stay, as the folder's, with what they were asked for, and the edit still names its original.
  media.deleteChat("chat-beta");
  const back = (await listed()).pictures.filter((p: any) => [first, second, "shot-edited.png"].includes(p.fileName));
  assert.deepEqual(back.map((p: any) => [p.fileName, p.origin, p.kind, p.prompt]).sort(), [
    [first, "folder", "generated", "a fox"],
    [second, "folder", "generated", "a bear"],
    ["shot-edited.png", "folder", "edited", "night"],
  ].sort());
  assert.ok(back.every((p: any) => p.chat === null && p.folder.name === "beta"));
  assert.equal(back.find((p: any) => p.fileName === "shot-edited.png").from, photo.id);
  assert.equal((await listed("?origin=folder")).pictures.filter((p: any) => [first, second, "shot-edited.png", original].includes(p.fileName)).length, 4, "and the same file is still one picture");
});

test("a chat in a folder inside a project leaves its pictures in the gallery when it goes, though nothing else names that folder", async () => {
  const zeta = project("zeta");
  const sub = path.join(zeta, "sub");
  mkdirSync(sub);
  chatIn("chat-sub", sub, "In sub");
  const file = "image-20260102-160000-444444.png";
  put(sub, file, png("sub"), T);
  gallery.recordChatPicture({ sessionId: "chat-sub", path: `${GENERATED_DIR}/${file}`, kind: "generated", prompt: "a hill", params: { model: "m" }, bytes: 70 });
  assert.equal((await listed("?origin=chat")).pictures.filter((p: any) => p.fileName === file).length, 1);
  // A picture the chat made before the page recorded anything of it is found with the folder, which only the chat names.
  const older = "image-20260102-150000-555555.png";
  put(sub, older, png("older"), T - 1000);
  media.deleteChat("chat-sub");
  const left = (await listed()).pictures.filter((p: any) => [file, older].includes(p.fileName));
  assert.deepEqual(left.map((p: any) => [p.fileName, p.origin, p.prompt, p.params, p.chat, p.folder]).sort(), [
    [file, "folder", "a hill", { model: "m" }, null, { name: "zeta/sub", home: false }],
    [older, "folder", "", {}, null, { name: "zeta/sub", home: false }],
  ].sort());
  assert.equal((await call("GET", `/images/${left.find((p: any) => p.fileName === file).id}/file`)).status, 200);
  // The folder stays looked in: what comes into it later is found.
  put(sub, "image-20260102-170000-666666.png", png("later"), T + 1000);
  assert.ok((await listed("?origin=folder")).pictures.some((p: any) => p.fileName === "image-20260102-170000-666666.png"));
  // A chat that goes while its folder cannot be reached has nowhere to leave them.
  const away = path.join(temp, "away-sub");
  chatIn("chat-gone", path.join(zeta, "gone"), "Gone");
  mkdirSync(path.join(zeta, "gone"));
  put(path.join(zeta, "gone"), "image-20260102-180000-777777.png", png("gone"), T);
  gallery.recordChatPicture({ sessionId: "chat-gone", path: `${GENERATED_DIR}/image-20260102-180000-777777.png`, kind: "generated", prompt: "unreachable", params: {}, bytes: 70 });
  renameSync(path.join(zeta, "gone"), away);
  media.deleteChat("chat-gone");
  renameSync(away, path.join(zeta, "gone"));
  assert.ok(!(getDb().prepare("SELECT 1 FROM images WHERE prompt = 'unreachable'").get()), "no row of it is left");
});

test("a found picture whose folder cannot be reached is not said to be deleted, and is still there when the folder is back", async () => {
  const eta = project("eta");
  const file = put(eta, "z.png", png("z"), T);
  const id = (await listed("?origin=folder")).pictures.find((p: any) => p.fileName === "z.png").id;
  const away = path.join(temp, "away-eta");
  renameSync(eta, away);
  const refused = await call("POST", "/images/delete", { ids: [id] });
  assert.deepEqual(refused.body.deleted, []);
  assert.deepEqual(refused.body.failed.map((f: any) => f.id), [id]);
  assert.match(refused.body.failed[0].error, /folder/i);
  assert.equal((await call("DELETE", `/images/${id}`)).status, 404);
  renameSync(away, eta);
  assert.equal(existsSync(file), true, "the file was never touched");
  const back = (await listed("?origin=folder")).pictures.filter((p: any) => p.fileName === "z.png");
  assert.deepEqual(back.map((p: any) => p.id), [id], "the same picture, not a new one");
});

test("a found picture and a recorded one are one picture also after a link is put above the folder", async () => {
  const theta = project("theta");
  put(theta, "old.png", png("old"), T);
  put(theta, "kept.png", png("kept"), T + 1000);
  const where = (name: string) => getDb().prepare("SELECT origin, folder FROM images WHERE path = ?").all(`${GENERATED_DIR}/${name}`) as { origin: string; folder: string | null }[];
  await listed("?origin=folder");
  assert.equal(where("old.png").length, 1);
  chatIn("chat-theta", theta, "Theta");
  // The workspace root goes to another disk and a link is left in its place.
  const moved = path.join(temp, "bigdisk");
  renameSync(root, moved);
  symlinkSync(moved, root);
  try {
    // The scan alone, before anything has dropped or renamed a row: it knows the files it has by where they really are.
    assert.equal(gallery.scanFolders(), 0);
    // A picture is recorded before anything has looked: the row that was found names the folder by its old path.
    gallery.recordChatPicture({ sessionId: "chat-theta", path: `${GENERATED_DIR}/old.png`, kind: "generated", prompt: "made again", params: {}, bytes: 70 });
    assert.deepEqual(where("old.png").map((r) => r.origin), ["chat"], "one entry, not the chat's beside the one that was found");
    // And a picture that was found is not found again under the new path.
    assert.equal((await listed("?origin=folder")).pictures.filter((p: any) => p.fileName === "kept.png").length, 1);
    assert.deepEqual(where("kept.png").map((r) => r.folder), [path.join(moved, "theta")], "kept under the folder as it really is");
    assert.equal(gallery.scanFolders(), 0);
  } finally {
    rmSync(root);
    renameSync(moved, root);
  }
});

test("a picture whose folder has become a link out of the place it is in is dropped, and found again when the link goes", async () => {
  const iota = project("iota");
  chatIn("chat-iota", project("iota-chat"), "Iota");
  put(iota, "x.png", png("x"), T);
  const recorded = path.join(root, "iota-chat");
  put(recorded, "image-20260102-190000-888888.png", png("r"), T);
  gallery.recordChatPicture({ sessionId: "chat-iota", path: `${GENERATED_DIR}/image-20260102-190000-888888.png`, kind: "generated", prompt: "recorded", params: {}, bytes: 70 });
  const id = (await listed("?origin=folder")).pictures.find((p: any) => p.fileName === "x.png").id;
  // The pictures are moved to a bigger disk, and a link is left where their folder was.
  const nas = path.join(temp, "nas");
  mkdirSync(nas);
  renameSync(path.join(iota, GENERATED_DIR), path.join(nas, "iota"));
  symlinkSync(path.join(nas, "iota"), path.join(iota, GENERATED_DIR));
  renameSync(path.join(recorded, GENERATED_DIR), path.join(nas, "iota-chat"));
  symlinkSync(path.join(nas, "iota-chat"), path.join(recorded, GENERATED_DIR));
  assert.notEqual((await call("GET", `/images/${id}/file`)).status, 200, "it is not served");
  const failed = await call("POST", "/images/delete", { ids: [id] });
  assert.deepEqual(failed.body.deleted, [], "and not deleted, from where it leads");
  const now = (await listed()).pictures.map((p: any) => p.fileName);
  assert.ok(!now.includes("x.png") && !now.includes("image-20260102-190000-888888.png"), "so it is not a tile that never loads and cannot be deleted either");
  assert.equal(existsSync(path.join(nas, "iota", "x.png")), true, "the file is not touched");
  assert.equal((await call("GET", `/images/${id}/file`)).status, 404);
  // The link goes, and the folder is as it was: what is in it is found.
  rmSync(path.join(iota, GENERATED_DIR));
  renameSync(path.join(nas, "iota"), path.join(iota, GENERATED_DIR));
  assert.ok((await listed("?origin=folder")).pictures.some((p: any) => p.fileName === "x.png"));
});

test("what goes from a folder goes from the gallery, and what comes into it comes into the gallery", async () => {
  const delta = project("delta");
  const a = put(delta, "a.png", png("a"), T);
  const b = put(delta, "b.png", png("b"), T + 1000);
  const c = put(delta, "c.png", png("c"), T + 2000);
  const mine = async () => names({ pictures: (await listed("?origin=folder")).pictures.filter((p: any) => p.folder?.name === "delta") });
  assert.deepEqual(await mine(), ["a.png", "b.png", "c.png"]);
  // Taken by hand, or turned into a link out of the folder: not shown, and nothing is served from it.
  const id = (await listed("?origin=folder")).pictures.find((p: any) => p.fileName === "b.png").id;
  rmSync(a);
  rmSync(b);
  symlinkSync(path.join(temp, "outside", "secret.png"), b);
  assert.deepEqual(await mine(), ["c.png"], "a link is no picture of the folder, found or not");
  assert.equal((await call("GET", `/images/${id}/file`)).status, 404);
  rmSync(b);
  // A file that went between the look and the open is no failure of the list either: the row names a file that is not there.
  getDb().prepare("INSERT INTO images (id, origin, session_id, folder, path, kind, bytes, created_at) VALUES ('d1d1d1d1d1d1', 'folder', NULL, ?, 'generated-images/vanished.png', 'unknown', 70, ?)").run(delta, T);
  assert.equal((await call("GET", "/images/d1d1d1d1d1d1/file")).status, 404);
  assert.deepEqual((await call("GET", "/images?ids=d1d1d1d1d1d1")).body.pictures, [], "dropped when it was asked for");

  // What is no picture is not opened again until it changes; then it is looked at again.
  const late = put(delta, "late.png", Buffer.from("x".repeat(70)), T + 3000);
  assert.deepEqual(await mine(), ["c.png"]);
  writeFileSync(late, png("late").subarray(0, 70));
  utimesSync(late, (T + 3000) / 1000, (T + 3000) / 1000);
  assert.deepEqual(await mine(), ["c.png"], "the file is as it was, to the size and the minute: it is not opened again");
  utimesSync(late, (T + 4000) / 1000, (T + 4000) / 1000);
  assert.deepEqual(await mine(), ["c.png", "late.png"], "changed: looked at again");
  // New files appear as they are made.
  put(delta, "image-20260102-150000-333333.png", png("new"), T + 5000);
  assert.deepEqual(await mine(), ["c.png", "image-20260102-150000-333333.png", "late.png"]);

  // A folder that is not there or cannot be read is no failure of the gallery, and its pictures are not kept as its chat's are: they are found again with it.
  const away = path.join(temp, "away");
  mkdirSync(away);
  renameSync(delta, path.join(away, "delta"));
  assert.deepEqual(await mine(), []);
  assert.equal((await call("GET", "/images?limit=1")).status, 200);
  renameSync(path.join(away, "delta"), delta);
  assert.deepEqual(await mine(), ["c.png", "image-20260102-150000-333333.png", "late.png"]);
  if (process.getuid?.() !== 0) {
    chmodSync(path.join(delta, GENERATED_DIR), 0);
    try {
      assert.equal((await call("GET", "/images?limit=1")).status, 200);
    } finally {
      chmodSync(path.join(delta, GENERATED_DIR), 0o755);
    }
  }
  // Deleted with its project: the folder goes, and so do the pictures found in it.
  rmSync(delta, { recursive: true });
  assert.deepEqual(await mine(), []);
  assert.equal(existsSync(c), false);
});

test("a picture that was found is deleted from its folder on purpose, one at a time or with others, and stays deleted", async () => {
  const epsilon = project("epsilon");
  const keep = put(epsilon, "keep.png", png("keep"), T);
  const one = put(epsilon, "one.png", png("one"), T + 1000);
  const two = put(epsilon, "two.png", png("two"), T + 2000);
  const three = put(epsilon, "three.png", png("three"), T + 3000);
  const pictures = (await listed("?origin=folder")).pictures.filter((p: any) => p.folder?.name === "epsilon");
  const id = (name: string) => pictures.find((p: any) => p.fileName === name).id;
  assert.equal((await call("DELETE", `/images/${id("one.png")}`)).status, 200);
  assert.equal(existsSync(one), false, "the file is taken from the folder");
  const several = await call("POST", "/images/delete", { ids: [id("two.png"), id("three.png")] });
  assert.deepEqual(several.body.deleted.sort(), [id("two.png"), id("three.png")].sort());
  assert.equal(existsSync(two) || existsSync(three), false);
  assert.equal(existsSync(keep), true);
  assert.deepEqual(names({ pictures: (await listed("?origin=folder")).pictures.filter((p: any) => p.folder?.name === "epsilon") }), ["keep.png"], "not found again");
  // One whose file went by hand is as good as deleted.
  rmSync(keep);
  assert.equal((await call("DELETE", `/images/${id("keep.png")}`)).status, 200);
});

test("a gallery of hundreds in a folder is listed once and paged, and looking again is a read of the names", async () => {
  const many = project("many");
  for (let i = 0; i < 300; i++) put(many, `image-20260102-1${String(i).padStart(5, "0")}-${i.toString(16).padStart(6, "0")}.png`, png(`m${i}`), T + i * 1000);
  const first = await listed("?origin=folder");
  assert.equal(first.total >= 300, true);
  assert.equal(first.pictures.length, 100);
  assert.ok(first.next);
  let all = first.pictures.length;
  let page = first;
  while (page.next) {
    page = (await call("GET", `/images?origin=folder&limit=100&before=${page.next}`)).body;
    all += page.pictures.length;
  }
  assert.equal(all, first.total, "every one once");
  const before = (getDb().prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n;
  assert.equal(gallery.scanFolders(), 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n, before);
});

test("the home of an agent other than the first is a folder of the gallery like the first one's: its pictures are found, kept when its chat goes, and named after it", async () => {
  const bot = createAgent({ name: "Research Bot" });
  chatIn("chat-bot", bot.home, "With the bot");
  const made = "image-20260102-190000-888888.png";
  // Newer than all the pictures before, so that they are on the first page of the list.
  const NEW = T + 10_000_000;
  put(bot.home, made, png("bot"), NEW);
  gallery.recordChatPicture({ sessionId: "chat-bot", path: `${GENERATED_DIR}/${made}`, kind: "generated", prompt: "a lake", params: {}, bytes: 70 });
  // Made before the gallery listed anything: found with the agent's home, which no chat has to name.
  const older = "image-20260102-185000-999999.png";
  put(bot.home, older, png("bot-older"), NEW - 1000);
  const mine = (await listed()).pictures.filter((p: any) => [made, older].includes(p.fileName));
  assert.deepEqual(mine.map((p: any) => [p.fileName, p.origin, p.chat?.title ?? null, p.folder]).sort(), [
    [made, "chat", "With the bot", null],
    [older, "folder", null, { name: "Research Bot", home: false }],
  ].sort());
  // The first agent's home is still Home.
  put(home, "image-20260102-200000-aaaaaa.png", png("home-again"), NEW + 1000);
  assert.deepEqual((await listed("?origin=folder")).pictures.find((p: any) => p.fileName === "image-20260102-200000-aaaaaa.png").folder, { name: "Agent", home: true });

  // The chat goes, and its picture stays with the home it was made in, served as before.
  media.deleteChat("chat-bot");
  const kept = (await listed()).pictures.find((p: any) => p.fileName === made);
  assert.deepEqual([kept.origin, kept.prompt, kept.folder], ["folder", "a lake", { name: "Research Bot", home: false }]);
  assert.equal((await call("GET", `/images/${kept.id}/file`)).status, 200);

  // An agent that is taken away with its folder kept leaves the pictures in the gallery, with what they were asked for and named by their folder, which no agent has now.
  deleteAgent(bot.id, { deleteFolder: false });
  const left = (await listed()).pictures.filter((p: any) => [made, older].includes(p.fileName));
  assert.deepEqual(left.map((p: any) => [p.fileName, p.prompt, p.folder]).sort(), [
    [made, "a lake", { name: "research-bot", home: false }],
    [older, "", { name: "research-bot", home: false }],
  ].sort());
  assert.equal((await call("GET", `/images/${left.find((p: any) => p.fileName === made).id}/file`)).status, 200);
  // Made again under the name, the agent has them, with what they were asked for.
  createAgent({ name: "Research Bot" });
  const back = (await listed()).pictures.filter((p: any) => [made, older].includes(p.fileName));
  assert.deepEqual(back.map((p: any) => [p.fileName, p.prompt, p.folder]).sort(), [
    [made, "a lake", { name: "Research Bot", home: false }],
    [older, "", { name: "Research Bot", home: false }],
  ].sort());
});

test("the pictures of a deleted agent's chats stay with a kept folder, and go with a deleted one, its routine runs' too", async () => {
  const bot = createAgent({ name: "Gallery Bot" });
  chatIn("chat-gallery-bot", bot.home, "With the bot");
  // A routine's run keeps its session when its agent is deleted, as a deleted agent's routines keep theirs.
  media.chat("run-1", bot.home, "A run", "routine");
  for (const [session, name, prompt] of [["chat-gallery-bot", "image-20260102-120000-aaaaaa.png", "a still lake"], ["run-1", "image-20260102-130000-bbbbbb.png", "a green hill"]]) {
    put(bot.home, name, png(name), T + 20_000_000);
    gallery.recordChatPicture({ sessionId: session, path: `${GENERATED_DIR}/${name}`, kind: "generated", prompt, params: {}, bytes: 72 });
  }
  const mine = async () => (await listed()).pictures.filter((p: any) => ["a still lake", "a green hill"].includes(p.prompt));
  assert.deepEqual((await mine()).map((p: any) => p.prompt).sort(), ["a green hill", "a still lake"]);

  // Its folder kept, as the portal deletes an agent: the agent goes, and then its chats (not its routine's runs).
  deleteAgent(bot.id, { deleteFolder: false });
  media.deleteChat("chat-gallery-bot");
  const kept = await mine();
  assert.deepEqual(kept.map((p: any) => [p.prompt, p.folder?.name ?? p.chat?.title]).sort(), [["a green hill", "A run"], ["a still lake", "gallery-bot"]]);
  // And the agent made again under the name has them, named after it.
  assert.equal(createAgent({ name: "Gallery Bot" }).id, bot.id);
  assert.deepEqual((await mine()).find((p: any) => p.prompt === "a still lake").folder, { name: "Gallery Bot", home: false });

  // Its folder deleted: the files are gone, and so are all of them, the run's too.
  deleteAgent(bot.id, { deleteFolder: true });
  media.folderRemoved(bot.home);
  assert.ok(!existsSync(bot.home));
  assert.deepEqual(await mine(), []);
});

test("a picture kept with what it was asked for stays while its folder is away, and is the same picture with its words when the folder is back", async () => {
  const omega = project("omega");
  const file = "image-20260102-190000-999991.png";
  chatIn("chat-omega", omega, "Omega");
  put(omega, file, png("omega"), T);
  gallery.recordChatPicture({ sessionId: "chat-omega", path: `${GENERATED_DIR}/${file}`, kind: "generated", prompt: "a kite over a hill", params: { seed: 7 }, bytes: 70 });
  media.deleteChat("chat-omega");
  const kept = (await listed("?origin=folder")).pictures.find((p: any) => p.fileName === file);
  assert.deepEqual([kept.prompt, kept.params], ["a kite over a hill", { seed: 7 }]);
  // A morning with the drive not mounted: the page is opened.
  const away = path.join(temp, "away-omega");
  renameSync(omega, away);
  assert.equal(gallery.pruneMissing(), 0, "nothing is said to be gone");
  await listed();
  renameSync(away, omega);
  const back = (await listed()).pictures.filter((p: any) => p.fileName === file);
  assert.deepEqual(back.map((p: any) => [p.id, p.prompt, p.params]), [[kept.id, "a kite over a hill", { seed: 7 }]], "the same picture, with its words");
  // Its file gone from a folder that is there is a picture that is gone.
  rmSync(path.join(omega, GENERATED_DIR, file));
  assert.equal(gallery.pruneMissing(), 1);
});

test("the pictures of a folder the portal removed go with it, those of another folder do not, and an edit's link to them goes", async () => {
  // Kept by where they really are, as Media keeps the folders of its pictures.
  const kappa = realpathSync(project("kappa"));
  const other = realpathSync(project("kappa-other"));
  const rows = getDb().prepare("INSERT INTO images (id, origin, folder, path, kind, prompt, source_id, created_at) VALUES (?, 'folder', ?, ?, 'generated', 'kept', ?, ?)");
  rows.run("kappa-1", kappa, `${GENERATED_DIR}/a.png`, null, 1);
  rows.run("kappa-2", kappa, `${GENERATED_DIR}/b.png`, "kappa-1", 2);
  rows.run("other-1", other, `${GENERATED_DIR}/a.png`, null, 3);
  rows.run("other-2", other, `${GENERATED_DIR}/b.png`, "kappa-1", 4);
  // The way the folder is spoken of is not always the way it really leads.
  const link = path.join(temp, "root-link");
  symlinkSync(root, link);
  rmSync(kappa, { recursive: true, force: true });
  media.folderRemoved(path.join(link, "kappa"));
  const left = getDb().prepare("SELECT id, source_id FROM images WHERE id LIKE 'kappa-%' OR id LIKE 'other-%' ORDER BY id").all();
  assert.deepEqual(left, [{ id: "other-1", source_id: null }, { id: "other-2", source_id: null }]);
});

test("forgetting pictures finds what was made of each by an index, with each statement made once", async () => {
  const d = getDb();
  const plan = (d.prepare("EXPLAIN QUERY PLAN UPDATE images SET source_id = NULL WHERE source_id = ?").all("x") as { detail: string }[]).map((r) => r.detail).join(" ");
  assert.match(plan, /idx_images_source/, plan);
  const lambda = project("lambda");
  const add = d.prepare("INSERT INTO images (id, origin, folder, path, kind, source_id, created_at) VALUES (?, 'folder', ?, ?, 'generated', ?, ?)");
  d.transaction(() => {
    for (let i = 0; i < 300; i++) add.run(`lambda-${i}`, lambda, `${GENERATED_DIR}/${i}.png`, i ? `lambda-${i - 1}` : null, i);
  })();
  const real = d.prepare.bind(d);
  let unlinks = 0;
  (d as any).prepare = (sql: string) => {
    if (/UPDATE images SET source_id = NULL WHERE source_id = \?/.test(sql)) unlinks++;
    return real(sql);
  };
  try {
    rmSync(lambda, { recursive: true, force: true });
    assert.equal(gallery.forgetPicturesIn(lambda), 300);
  } finally {
    delete (d as any).prepare;
  }
  assert.ok(unlinks <= 1, `${unlinks} statements made for 300 pictures`);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM images WHERE id LIKE 'lambda-%'").get().n, 0);
});

test("a page that asks again for the top of its list does not make the portal look through every folder each time", async () => {
  const folder = project("again");
  put(folder, "first.png", png("first"));
  assert.ok(names(await listed()).includes("first.png"), "opening the page looks");
  // Put there by hand, so that nothing recorded it: only a look finds it.
  put(folder, "second.png", png("second"));
  const again = async () => (await call("GET", "/images?again=1&limit=100")).body;
  assert.ok(!names(await again()).includes("second.png"), "a page asking again, a moment after a look, is told what that look found");
  assert.ok(names(await listed()).includes("second.png"), "the Refresh button looks at once");
  // A file that went is dropped by a look as well.
  rmSync(path.join(folder, GENERATED_DIR, "first.png"));
  assert.ok(names(await again()).includes("first.png"));
  assert.ok(!names(await listed()).includes("first.png"));

  // Asking again after the minute looks.
  put(folder, "third.png", png("third"));
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    mock.timers.tick(gallery.LOOK_AGAIN_MS - 1000);
    assert.ok(!gallery.listPictures({ again: true, limit: 100 }).pictures.some((p) => p.fileName === "third.png"));
    mock.timers.tick(2000);
    assert.ok(gallery.listPictures({ again: true, limit: 100 }).pictures.some((p) => p.fileName === "third.png"), "found after a minute");
  } finally {
    mock.timers.reset();
  }
});
