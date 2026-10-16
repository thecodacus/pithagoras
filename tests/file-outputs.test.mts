import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { scratch } from "./helpers.mts";
import { FILES_KEY, fileOutputs, shownFiles } from "../core/server/src/file-outputs.ts";
import { filesFound, withFiles } from "../core/server/src/output-files.ts";
import { filesOnOldCalls } from "../core/server/src/old-call-files.ts";

// What a call gave the person: its `details.files`, as any tool says it, and what the portal finds of each by its bytes.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(20)]);
const AVI = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI "), Buffer.alloc(20)]);

function folderWith(files: Record<string, Buffer | string>): string {
  const folder = realpathSync(scratch("file-outputs-"));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), bytes);
  }
  return folder;
}

test("a tool names its files in its details: a path each, a title and what it was made from if it has them", () => {
  assert.deepEqual(fileOutputs({ files: [{ path: "a.png", title: "  A  long\n title ", from: ["b.png", 3, ""] }, { path: "c.csv" }] }), [
    { path: "a.png", title: "A long title", from: ["b.png"] },
    { path: "c.csv" },
  ]);
  // What names no file is none: no list, an entry with no path, details that are not an object.
  for (const details of [undefined, null, "a.png", { files: "a.png" }, { path: "a.png" }, { files: [{ title: "x" }, { path: "  " }, null] }]) {
    assert.deepEqual(fileOutputs(details), [], JSON.stringify(details));
  }
  assert.equal(fileOutputs({ files: [{ path: "a.png", title: "x".repeat(300) }] })[0].title!.length, 120);
});

test("the end of a call is read for what the portal found of its files, and for nothing else", () => {
  const found = [{ path: "a.png", kind: "picture", title: "A" }, { path: "b.mp4", kind: "video", from: ["a.png"] }, { path: "c.csv", kind: "file" }];
  assert.deepEqual(shownFiles({ [FILES_KEY]: found }), found);
  // A kind the portal does not give, or no path, is left out; what the tool's own details say is not read here.
  assert.deepEqual(shownFiles({ [FILES_KEY]: [{ path: "a.png", kind: "page" }, { kind: "picture" }] }), []);
  assert.deepEqual(shownFiles({ result: { details: { files: [{ path: "a.png" }] } } }), []);
});

test("each file is what its bytes say, wherever it is named from in the folder, and one that is not a file of the folder is left out", () => {
  const folder = folderWith({ "chart.png": PNG, "clips/fox.mp4": MP4, "old.avi": AVI, "notes.txt": "hello", "named.png": "not a picture", "sub/x.txt": "x" });
  const outside = folderWith({ "secret.png": PNG });
  symlinkSync(path.join(outside, "secret.png"), path.join(folder, "link.png"));
  // A picture larger than the picture route draws (25 MB), as a sparse file: one to save.
  writeFileSync(path.join(folder, "huge.png"), PNG);
  truncateSync(path.join(folder, "huge.png"), 26 * 1024 * 1024);
  const files = filesFound(folder, {
    files: [
      { path: "chart.png", title: "Chart" },
      { path: path.join(folder, "clips/fox.mp4") },
      // A clip a browser does not play, and a file called a picture that is none, are files to save.
      { path: "old.avi" },
      { path: "named.png" },
      { path: "huge.png" },
      { path: "./notes.txt", from: ["chart.png", path.join(folder, "clips/fox.mp4"), "../elsewhere.png"] },
      // Not given: outside the folder, through a link out of it, not there, a folder.
      { path: "../x.png" },
      { path: path.join(outside, "secret.png") },
      { path: "link.png" },
      { path: "gone.png" },
      { path: "sub" },
    ],
  });
  assert.deepEqual(files, [
    { path: "chart.png", kind: "picture", title: "Chart" },
    { path: "clips/fox.mp4", kind: "video" },
    { path: "old.avi", kind: "file" },
    { path: "named.png", kind: "file" },
    { path: "huge.png", kind: "file" },
    { path: "notes.txt", kind: "file", from: ["chart.png", "clips/fox.mp4"] },
  ]);
  assert.deepEqual(filesFound(path.join(folder, "no-such-folder"), { files: [{ path: "chart.png" }] }), [], "a chat whose folder is gone gave nothing that can be shown");
});

test("the end of a call that succeeded and named files says what they are; any other event is as it was", () => {
  const folder = folderWith({ "chart.png": PNG });
  const end = { type: "tool_execution_end", toolName: "plot", result: { details: { files: [{ path: "chart.png" }] } } };
  assert.deepEqual(withFiles(end, folder)[FILES_KEY], [{ path: "chart.png", kind: "picture" }]);
  for (const event of [{ ...end, isError: true }, { ...end, type: "tool_execution_update" }, { ...end, result: { details: { files: [{ path: "gone.png" }] } } }, { type: "message_end" }]) {
    assert.equal(withFiles(event, folder), event, JSON.stringify(event));
  }
});

test("the upgrade gives the ends of the portal's picture and clip calls kept before the files they showed, an edit its original, and leaves the rest", () => {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL);
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE message_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, rows TEXT NOT NULL);
  `);
  d.prepare("INSERT INTO sessions VALUES ('s', '/work/proj')").run();
  const put = (type: string, payload: object) => d.prepare("INSERT INTO events (session_id, type, payload) VALUES ('s', ?, ?)").run(type, JSON.stringify(payload)).lastInsertRowid;
  const ended = (toolName: string, details: object, extra: object = {}) => ({ toolName, toolCallId: `c-${toolName}-${JSON.stringify(details).length}`, result: { details }, ...extra });
  const shown = put("tool_execution_end", ended("show_image", { path: "a.png", title: "A" }));
  const made = put("tool_execution_end", ended("generate_image", { path: "g/b.png", portalImage: true }));
  put("tool_execution_start", { toolName: "tools", toolCallId: "e1", args: { action: "call", name: "edit_image", args: { paths: ["/work/proj/a.png", "g/b.png", "/elsewhere/c.png"] } } });
  const edited = put("tool_execution_end", { toolName: "tools", toolCallId: "e1", portalCalledTool: "edit_image", result: { details: { path: "g/a-edited.png", title: "Red", portalImage: true } } });
  const clip = put("tool_execution_end", ended("generate_video", { path: "v/fox.webm", portalVideo: true }));
  const kept = put("tool_execution_end", ended("generate_video", { path: "v/old.avi", notPlayable: "AVI", portalVideo: true }));
  const showClip = put("tool_execution_end", ended("show_video", { path: "v/fox.webm" }));
  // Not theirs: an extension's tool of the name, a failed call, another tool, an end that says so already.
  const theirs = put("tool_execution_end", ended("generate_image", { path: "/abs/cat.png" }));
  const failed = put("tool_execution_end", ended("show_image", { path: "a.png" }, { isError: true }));
  const other = put("tool_execution_end", ended("docs_open", { path: "a.png", note: "show_image" }));
  const already = put("tool_execution_end", ended("show_image", { path: "a.png" }, { [FILES_KEY]: [{ path: "x.png", kind: "picture" }] }));
  // A version of a message, with an edit whose start is among its own events.
  const rows = [
    { seq: 20, session_id: "s", type: "tool_execution_start", payload: JSON.stringify({ toolName: "edit_image", toolCallId: "v1", args: { path: "a.png" } }) },
    { seq: 21, session_id: "s", type: "tool_execution_end", payload: JSON.stringify({ toolName: "edit_image", toolCallId: "v1", result: { details: { path: "g/a-v.png", portalImage: true } } }) },
  ];
  d.prepare("INSERT INTO message_versions (session_id, rows) VALUES ('s', ?)").run(JSON.stringify(rows));
  const before = (seq: number | bigint) => (d.prepare("SELECT payload FROM events WHERE seq = ?").get(seq) as { payload: string }).payload;
  const untouched = [theirs, failed, other, already].map((seq) => [seq, before(seq)] as const);

  filesOnOldCalls(d);
  const files = (seq: number | bigint) => JSON.parse(before(seq))[FILES_KEY];
  assert.deepEqual(files(shown), [{ path: "a.png", kind: "picture", title: "A" }]);
  assert.deepEqual(files(made), [{ path: "g/b.png", kind: "picture" }]);
  assert.deepEqual(files(edited), [{ path: "g/a-edited.png", kind: "picture", title: "Red", from: ["a.png", "g/b.png"] }], "what it was given that is in the folder, from its start through the gateway");
  assert.deepEqual(files(clip), [{ path: "v/fox.webm", kind: "video" }]);
  assert.deepEqual(files(kept), [{ path: "v/old.avi", kind: "file" }], "one a browser cannot play is a file to save");
  assert.deepEqual(files(showClip), [{ path: "v/fox.webm", kind: "video" }]);
  assert.equal(JSON.parse(before(shown)).result.details.path, "a.png", "and nothing else of it is changed");
  for (const [seq, payload] of untouched) assert.equal(before(seq), payload);
  const version = JSON.parse((d.prepare("SELECT rows FROM message_versions").get() as { rows: string }).rows);
  assert.equal(version[0].payload, rows[0].payload);
  assert.deepEqual(JSON.parse(version[1].payload)[FILES_KEY], [{ path: "g/a-v.png", kind: "picture", from: ["a.png"] }]);
  assert.equal(version[1].seq, 21);
});
