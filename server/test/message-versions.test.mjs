import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-versions-");

const { createSession, eventsSince, sentMessages, getDb, getSession, appendEvent, updateSession } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
test.after(() => getDb().close());

const entry = (id, parentId, role, text) => JSON.stringify({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }] } });
const reply = (text) => ({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const answers = (id) =>
  eventsSince(id)
    .filter((e) => e.type === "message_end")
    .map((e) => JSON.parse(e.payload).message.content[0]?.text);
/** How many times the pages holding a chat are told to load it again. */
function reloads(id) {
  const heard = { count: 0 };
  sessions.on(`session:${id}`, (row) => row.type === "portal_reload" && heard.count++);
  return heard;
}

/**
 * A chat of `turns` — each a message and its answer — in pi's file and the
 * transcript, with a pi that answers whatever it is sent, as `answer` says.
 */
function chat(id, turns, answer = (m) => `answer to ${m}`) {
  createSession({ id, title: id, workspace: home, executor: "host" });
  const file = path.join(home, `${id}.jsonl`);
  const lines = [JSON.stringify({ type: "session", id: "s" })];
  const seqs = [];
  let parent = null;
  turns.forEach((m, i) => {
    lines.push(entry(`u${i}`, parent, "user", m), entry(`a${i}`, `u${i}`, "assistant", answer(m)));
    parent = `a${i}`;
    seqs.push(appendEvent(id, "portal_prompt", { message: m }).seq);
    appendEvent(id, "message_end", reply(answer(m)));
  });
  writeFileSync(file, lines.join("\n") + "\n");
  updateSession(id, { pi_session_file: file, status: "idle" });
  let written = 0;
  const client = {
    running: false,
    prompt: async (message) => {
      // pi adds what it was sent and its answer to its file, under the last entry, and says so.
      const at = getSession(id).pi_session_file ?? file;
      const text = readFileSync(at, "utf8");
      const leaf = JSON.parse(text.trim().split("\n").at(-1)).id;
      const n = ++written;
      // As pi does on opening a conversation again: its settings, before what it was sent.
      const settings = JSON.stringify({ type: "thinking_level_change", id: `t${n}`, parentId: leaf, thinkingLevel: "medium" });
      writeFileSync(at, text + settings + "\n" + entry(`n${n}`, `t${n}`, "user", message) + "\n" + entry(`r${n}`, `n${n}`, "assistant", answer(message)) + "\n");
      setImmediate(() => {
        sessions.record(id, "agent_start", {});
        sessions.record(id, "message_end", reply(answer(message)));
        sessions.record(id, "agent_settled", {});
      });
    },
    getState: async () => ({ model: { id: "m", name: "M", provider: "p", input: ["text"] }, thinkingLevel: "off" }),
    getCommands: async () => [],
    isIdle: () => true,
    clearQueue: () => {},
    abort: async () => {},
  };
  sessions.ensureClient = async () => client;
  return { file, seqs };
}

/** What a page is told to drop: said live, never stored. */
function removals(id) {
  const seen = [];
  sessions.on(`session:${id}`, (row) => row.type === "portal_removed" && seen.push(JSON.parse(row.payload)));
  return seen;
}

async function until(check, what = "the server to catch up") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a message sent again keeps what it replaced as a version to switch back to", async () => {
  const { file, seqs } = chat("again", ["hello", "what is pi"]);
  const before = readFileSync(file, "utf8");
  const removed = removals("again");
  const reloaded = reloads("again");
  await sessions.editMessage("again", seqs[1], "what is tau");
  await until(() => answers("again").includes("answer to what is tau"));
  // The page dropped the old turn when the edit was made, not once answered.
  assert.equal(removed.length, 1);
  assert.equal(removed[0].from, seqs[1]);
  const now = sentMessages("again").map((m) => m.seq);
  assert.deepEqual(answers("again"), ["answer to hello", "answer to what is tau"]);
  // The edited message has two versions, the old first; the first message has one.
  assert.deepEqual(sessions.messageVersions("again"), { [now[1]]: [seqs[1], now[1]] });
  const edited = readFileSync(file, "utf8");

  // Back to the first version: its turn, and pi's file as it was then.
  await sessions.switchVersion("again", now[1], seqs[1]);
  assert.deepEqual(sentMessages("again").map((m) => m.message), ["hello", "what is pi"]);
  assert.deepEqual(answers("again"), ["answer to hello", "answer to what is pi"]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(sessions.messageVersions("again"), { [seqs[1]]: [seqs[1], now[1]] });
  // Its events came back under seqs every page has read past: they load the chat again.
  assert.equal(reloaded.count, 1);
  // A page that was away hears it from the count its stream starts with; nothing is kept in the transcript.
  // One for the edit's removal, one for this.
  assert.equal(getSession("again").reloads, 2);
  assert.ok(!eventsSince("again").some((e) => e.type === "portal_reload"));

  // And forward again to the edit.
  await sessions.switchVersion("again", seqs[1], now[1]);
  assert.deepEqual(answers("again"), ["answer to hello", "answer to what is tau"]);
  assert.equal(readFileSync(file, "utf8"), edited);
  assert.equal(reloaded.count, 2);
});

test("versions of a later message go with the version of an earlier one they followed", async () => {
  const { seqs } = chat("nested", ["one", "two"]);
  // Two sent again, then one: the second message's versions belong to the first one's old version.
  await sessions.editMessage("nested", seqs[1], "two again");
  await until(() => answers("nested").includes("answer to two again"));
  const twoAgain = sentMessages("nested")[1].seq;
  await sessions.editMessage("nested", seqs[0], "one again");
  await until(() => answers("nested").includes("answer to one again"));
  const oneAgain = sentMessages("nested")[0].seq;
  assert.deepEqual(sessions.messageVersions("nested"), { [oneAgain]: [seqs[0], oneAgain] });
  await sessions.switchVersion("nested", oneAgain, seqs[0]);
  assert.deepEqual(sentMessages("nested").map((m) => m.message), ["one", "two again"]);
  assert.deepEqual(sessions.messageVersions("nested"), { [seqs[0]]: [seqs[0], oneAgain], [twoAgain]: [seqs[1], twoAgain] });
});

test("an edit that gets no answer is undone, and leaves no version behind", async () => {
  const { file, seqs } = chat("undone", ["hi"]);
  const before = readFileSync(file, "utf8");
  const reloaded = reloads("undone");
  const client = await sessions.ensureClient();
  // The run starts, and fails before a word of answer.
  client.isIdle = () => false;
  client.prompt = async () => void setImmediate(() => sessions.record("undone", "portal_status", { status: "error", error: "The run failed: gone" }));
  await sessions.editMessage("undone", seqs[0], "hi again");
  await until(() => readFileSync(file, "utf8") === before);
  assert.deepEqual(sentMessages("undone").map((m) => m.message), ["hi"]);
  assert.deepEqual(sessions.messageVersions("undone"), {});
  // The page dropped the old turn at once, and has it back by loading again.
  await until(() => reloaded.count === 1);
});

test("taking a message out forgets the versions of the ones after it", async () => {
  const { seqs } = chat("taken", ["a", "b", "c"]);
  await sessions.editMessage("taken", seqs[2], "c again");
  await until(() => answers("taken").includes("answer to c again"));
  assert.equal(Object.keys(sessions.messageVersions("taken")).length, 1);
  // Its versions went on from a conversation with "b" in it.
  await sessions.removeMessage("taken", seqs[1], "turn");
  assert.deepEqual(sessions.messageVersions("taken"), {});
});

test("a version that is not there, or a chat that is working, is refused", async () => {
  const { seqs } = chat("refused", ["x"]);
  await assert.rejects(sessions.switchVersion("refused", seqs[0], 99999), /gone/);
  await sessions.editMessage("refused", seqs[0], "y");
  await until(() => answers("refused").includes("answer to y"));
  const y = sentMessages("refused")[0].seq;
  sessions.isBusy = (id) => id === "refused";
  try {
    await assert.rejects(sessions.switchVersion("refused", y, seqs[0]), /Stop the run/);
  } finally {
    delete sessions.isBusy;
  }
  assert.deepEqual(sentMessages("refused").map((m) => m.message), ["y"]);
});

test("taking a message out keeps the versions kept in branches it was never in", async () => {
  // M1 → M2; M1 edited to M1'; in that branch M3, edited to M3'; back to M1, and M2 taken out.
  const { seqs } = chat("hidden", ["m1", "m2"]);
  await sessions.editMessage("hidden", seqs[0], "m1 again");
  await until(() => answers("hidden").includes("answer to m1 again"));
  const m1again = sentMessages("hidden")[0].seq;
  await sessions.prompt("hidden", "m3");
  await until(() => answers("hidden").includes("answer to m3"));
  const m3 = sentMessages("hidden")[1].seq;
  await sessions.editMessage("hidden", m3, "m3 again");
  await until(() => answers("hidden").includes("answer to m3 again"));
  const m3again = sentMessages("hidden")[1].seq;
  await sessions.switchVersion("hidden", m1again, seqs[0]);
  // Every seq in the branch shown now is lower than M3's: "at or after" took M3's versions too.
  await sessions.removeMessage("hidden", seqs[1], "turn");
  await sessions.switchVersion("hidden", seqs[0], m1again);
  assert.deepEqual(sentMessages("hidden").map((m) => m.message), ["m1 again", "m3 again"]);
  assert.deepEqual(sessions.messageVersions("hidden")[m3again], [m3, m3again]);
});

test("a message taken out takes its own versions with it, rather than leaving them to the next", async () => {
  const { seqs } = chat("ownversions", ["a", "b", "c"]);
  await sessions.editMessage("ownversions", seqs[1], "b again");
  await until(() => answers("ownversions").includes("answer to b again"));
  await sessions.prompt("ownversions", "c again");
  await until(() => answers("ownversions").includes("answer to c again"));
  const bAgain = sentMessages("ownversions")[1].seq;
  await sessions.removeMessage("ownversions", bAgain, "turn");
  assert.deepEqual(sentMessages("ownversions").map((m) => m.message), ["a", "c again"]);
  // "b"'s old version showed under "c again" as 1/2, and switching to it brought "b" back.
  assert.deepEqual(sessions.messageVersions("ownversions"), {});
});

test("an edit whose version cannot be kept changes nothing", async () => {
  const { file, seqs } = chat("unkept", ["x", "y"]);
  const before = readFileSync(file, "utf8");
  const schema = getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'message_versions'").get().sql;
  getDb().exec("DROP TABLE message_versions");
  try {
    await assert.rejects(sessions.editMessage("unkept", seqs[1], "y again"), /message_versions/);
  } finally {
    getDb().exec(schema);
  }
  // It was cut, the version failed to save, and the turn was gone.
  assert.deepEqual(sentMessages("unkept").map((m) => m.message), ["x", "y"]);
  assert.deepEqual(answers("unkept"), ["answer to x", "answer to y"]);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a switch that fails to bring a version back leaves the conversation and both versions as they were", async () => {
  const { file, seqs } = chat("halfway", ["p", "q"]);
  await sessions.editMessage("halfway", seqs[1], "q again");
  await until(() => answers("halfway").includes("answer to q again"));
  const qAgain = sentMessages("halfway")[1].seq;
  const edited = readFileSync(file, "utf8");
  // Putting the old events back fails partway, as a locked or full database would.
  getDb().exec(`CREATE TRIGGER no_restore BEFORE INSERT ON events WHEN NEW.payload LIKE '%answer to q"%'
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  try {
    await assert.rejects(sessions.switchVersion("halfway", qAgain, seqs[1]), /disk I\/O error/);
  } finally {
    getDb().exec("DROP TRIGGER no_restore");
  }
  // The version asked for was taken out first, and lost with the chat cut short.
  assert.deepEqual(sentMessages("halfway").map((m) => m.message), ["p", "q again"]);
  assert.deepEqual(answers("halfway"), ["answer to p", "answer to q again"]);
  assert.equal(readFileSync(file, "utf8"), edited);
  assert.deepEqual(sessions.messageVersions("halfway"), { [qAgain]: [seqs[1], qAgain] });
  await sessions.switchVersion("halfway", qAgain, seqs[1]);
  assert.deepEqual(answers("halfway"), ["answer to p", "answer to q"]);
});

test("a compaction after an edited message goes and comes back with its version", async () => {
  const { file, seqs } = chat("compacted", ["r", "s"]);
  const before = readFileSync(file, "utf8");
  await sessions.editMessage("compacted", seqs[1], "s again");
  await until(() => answers("compacted").includes("answer to s again"));
  const sAgain = sentMessages("compacted")[1].seq;
  // Compacted since: in the transcript, and in pi's file after the edited message.
  sessions.record("compacted", "compaction_end", { result: { summary: "r and s again", tokensBefore: 900 } });
  const leaf = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)).id;
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ type: "compaction", id: "c1", parentId: leaf, summary: "r and s again" }) + "\n");
  const compacted = readFileSync(file, "utf8");
  const compactions = () => eventsSince("compacted").filter((e) => e.type === "compaction_end").length;
  // The older version never had it: neither its transcript nor pi's file does.
  await sessions.switchVersion("compacted", sAgain, seqs[1]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(compactions(), 0);
  await sessions.switchVersion("compacted", seqs[1], sAgain);
  assert.equal(readFileSync(file, "utf8"), compacted);
  assert.equal(compactions(), 1);
});

test("a version keeps what follows the start it shares, not the whole of pi's file again", async () => {
  const { file, seqs } = chat("suffix", ["first " + "long words ".repeat(400), "second"]);
  const before = readFileSync(file, "utf8");
  await sessions.editMessage("suffix", seqs[1], "second again");
  await until(() => answers("suffix").includes("answer to second again"));
  const kept = getDb().prepare("SELECT file, file_prefix FROM message_versions WHERE session_id = 'suffix'").get();
  // It kept all of it: a long chat's file again with every retry.
  assert.ok(kept.file.length < before.length / 2, `kept ${kept.file.length} of ${before.length}`);
  assert.equal(before.slice(kept.file_prefix), kept.file);
  await sessions.switchVersion("suffix", sentMessages("suffix")[1].seq, seqs[1]);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a version whose conversation pi's file no longer starts with is refused, and nothing changes", async () => {
  const { file, seqs } = chat("replaced", ["u", "v"]);
  await sessions.editMessage("replaced", seqs[1], "v again");
  await until(() => answers("replaced").includes("answer to v again"));
  const vAgain = sentMessages("replaced")[1].seq;
  // pi's file is another now: rewritten outside the portal, or another file altogether.
  const other = [JSON.stringify({ type: "session", id: "t" }), entry("x0", null, "user", "u, said otherwise"), entry("x1", "x0", "assistant", "hm")].join("\n") + "\n";
  writeFileSync(file, other);
  // It was written over with the old one, whatever was in it now.
  await assert.rejects(sessions.switchVersion("replaced", vAgain, seqs[1]), /changed since that version was kept/);
  assert.equal(readFileSync(file, "utf8"), other);
  assert.deepEqual(sentMessages("replaced").map((m) => m.message), ["u", "v again"]);
  assert.deepEqual(sessions.messageVersions("replaced"), { [vAgain]: [seqs[1], vAgain] });
});

/**
 * A disk that takes nothing more in `dir`, and gives it back. The folder is put
 * aside and a file left in its place, so a write under it fails for every user;
 * permissions would not do it, as root ignores them and the tests also run as root.
 */
function fullDisk(dir) {
  return {
    fill: () => { renameSync(dir, `${dir}.away`); writeFileSync(dir, ""); },
    empty: () => { if (statSync(dir).isFile()) { rmSync(dir); renameSync(`${dir}.away`, dir); } },
  };
}

test("a version kept when there was no file of pi's is refused once there is one", async () => {
  const { file, seqs } = chat("nofile", ["g", "h"]);
  const text = readFileSync(file, "utf8");
  updateSession("nofile", { pi_session_file: null });
  await sessions.editMessage("nofile", seqs[1], "h again");
  await until(() => answers("nofile").includes("answer to h again"));
  const hAgain = sentMessages("nofile")[1].seq;
  updateSession("nofile", { pi_session_file: file });
  writeFileSync(file, text);
  // pi's file stayed cut back, without the turn shown.
  await assert.rejects(sessions.switchVersion("nofile", hAgain, seqs[1]), /changed since/);
  assert.equal(readFileSync(file, "utf8"), text);
  assert.deepEqual(sentMessages("nofile").map((m) => m.message), ["g", "h again"]);
});

test("a switch whose file and then whose putting back both fail still shows what it showed", async () => {
  const dir = mkdtempSync(path.join(home, "locked-"));
  const { file, seqs } = chat("twice", ["k", "l"]);
  const moved = path.join(dir, "twice.jsonl");
  writeFileSync(moved, readFileSync(file, "utf8"));
  updateSession("twice", { pi_session_file: moved });
  await sessions.editMessage("twice", seqs[1], "l again");
  await until(() => answers("twice").includes("answer to l again"));
  const lAgain = sentMessages("twice")[1].seq;
  const shown = readFileSync(moved, "utf8");
  // Once cut, the disk takes nothing more, and keeping the version being taken fails too.
  const disk = fullDisk(dir);
  const cut = sessions.cut;
  sessions.cut = async function (...args) {
    const done = await cut.apply(this, args);
    disk.fill();
    getDb().exec(`CREATE TRIGGER no_keep BEFORE INSERT ON message_versions WHEN NEW.seq = ${seqs[1]} BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
    const undo = done.undo;
    return { ...done, undo: async () => (disk.empty(), undo()) };
  };
  try {
    // The error from the rollback took the place of the switch's own, and what was shown was never put back.
    await assert.rejects(sessions.switchVersion("twice", lAgain, seqs[1]), /ENOTDIR|not a directory/);
  } finally {
    sessions.cut = cut;
    disk.empty();
    getDb().exec("DROP TRIGGER IF EXISTS no_keep");
  }
  assert.deepEqual(sentMessages("twice").map((m) => m.message), ["k", "l again"]);
  assert.deepEqual(answers("twice"), ["answer to k", "answer to l again"]);
  assert.equal(readFileSync(moved, "utf8"), shown);
});

test("a message is taken out with the versions it takes, or not at all", async () => {
  const { file, seqs } = chat("together", ["m", "n", "o"]);
  await sessions.editMessage("together", seqs[2], "o again");
  await until(() => answers("together").includes("answer to o again"));
  const before = readFileSync(file, "utf8");
  getDb().exec("CREATE TRIGGER no_forget BEFORE DELETE ON message_versions BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
  try {
    await assert.rejects(sessions.removeMessage("together", seqs[1], "turn"), /database is locked/);
  } finally {
    getDb().exec("DROP TRIGGER no_forget");
  }
  // It was gone from the transcript and pi's file, the page never told, and the versions left to bring it back.
  assert.deepEqual(sentMessages("together").map((m) => m.message), ["m", "n", "o again"]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(Object.keys(sessions.messageVersions("together")).length, 1);
});

test("a version goes back onto its conversation after pi has written its settings into the other", async () => {
  // What the host showed: 7 edited to 42, back to 7, a question, and forward to 42 again was refused.
  const { file, seqs } = chat("settings", ["number is 7"]);
  await sessions.editMessage("settings", seqs[0], "number is 42");
  await until(() => answers("settings").includes("answer to number is 42"));
  const v2 = sentMessages("settings")[0].seq;
  const withV2 = readFileSync(file, "utf8");
  await sessions.switchVersion("settings", v2, seqs[0]);
  await sessions.prompt("settings", "which number?");
  await until(() => answers("settings").includes("answer to which number?"));
  await sessions.switchVersion("settings", seqs[0], v2);
  assert.deepEqual(sentMessages("settings").map((m) => m.message), ["number is 42"]);
  assert.equal(readFileSync(file, "utf8"), withV2);
});

test("a switch undone on a disk that takes nothing more still shows the conversation it showed", async () => {
  const dir = mkdtempSync(path.join(home, "full-"));
  const { file, seqs } = chat("fulldisk", ["s1", "s2"]);
  const moved = path.join(dir, "fulldisk.jsonl");
  writeFileSync(moved, readFileSync(file, "utf8"));
  updateSession("fulldisk", { pi_session_file: moved });
  await sessions.editMessage("fulldisk", seqs[1], "s2 again");
  await until(() => answers("fulldisk").includes("answer to s2 again"));
  const again = sentMessages("fulldisk")[1].seq;
  // Once cut, the disk takes nothing more: not the switch's file, and not the undoing's either.
  const disk = fullDisk(dir);
  const cut = sessions.cut;
  sessions.cut = async function (...args) {
    const done = await cut.apply(this, args);
    disk.fill();
    return done;
  };
  try {
    await assert.rejects(sessions.switchVersion("fulldisk", again, seqs[1]), /ENOTDIR|not a directory/);
  } finally {
    sessions.cut = cut;
    disk.empty();
  }
  // The file was written first and threw: the transcript was never put back, and neither version could be reached.
  assert.deepEqual(sentMessages("fulldisk").map((m) => m.message), ["s1", "s2 again"]);
  assert.deepEqual(answers("fulldisk"), ["answer to s1", "answer to s2 again"]);
  assert.deepEqual(sessions.messageVersions("fulldisk"), { [again]: [seqs[1], again] });
});

test("every change to what a chat shows counts as one a page that was away must load again for", async () => {
  const { seqs } = chat("counted", ["c1", "c2", "c3"]);
  const told = [];
  sessions.on("session:counted", (row) => ["portal_removed", "portal_versions"].includes(row.type) && told.push({ type: row.type, ...JSON.parse(row.payload) }));
  await sessions.editMessage("counted", seqs[2], "c3 again");
  await until(() => answers("counted").includes("answer to c3 again"));
  const again = sentMessages("counted")[2].seq;
  // Said live only: a page whose stream was down kept the old turn, the replacement under it.
  assert.equal(getSession("counted").reloads, 1);
  assert.equal(told.find((t) => t.type === "portal_removed").reloads, 1);
  // And the versions, once the replacement has its seq, rather than each page asking.
  assert.deepEqual(told.find((t) => t.type === "portal_versions").versions, { [again]: [seqs[2], again] });
  await sessions.removeMessage("counted", seqs[1], "turn");
  assert.equal(getSession("counted").reloads, 2);
  assert.deepEqual(told.at(-1), { type: "portal_versions", versions: {} });
});

test("a version's part of pi's file does not start halfway through a character", async () => {
  const { keptFile } = await import("../dist/session-manager.js");
  // 😀 and 😃 share their first half: the split fell between the halves.
  const kept = keptFile('{"text":"ab😀cd"}', '{"text":"ab😃xy"}');
  assert.equal(kept.file, '😀cd"}');
  assert.equal(kept.filePrefix, '{"text":"ab'.length);
});

test("a switch reads pi's file once pi has stopped, and refuses on what it finds then", async () => {
  const { file, seqs } = chat("stopped", ["t1", "t2"]);
  await sessions.editMessage("stopped", seqs[1], "t2 again");
  await until(() => answers("stopped").includes("answer to t2 again"));
  const again = sentMessages("stopped")[1].seq;
  // pi, stopping, writes its file anew: another conversation from the start.
  const other = [JSON.stringify({ type: "session", id: "z" }), entry("z0", null, "user", "t1, said otherwise"), entry("z1", "z0", "assistant", "hm")].join("\n") + "\n";
  const stop = sessions.stop;
  sessions.stop = async function (...args) {
    writeFileSync(file, other);
    return stop.apply(this, args);
  };
  try {
    // Checked against the file read before it stopped, and then written over what pi had just written.
    await assert.rejects(sessions.switchVersion("stopped", again, seqs[1]), /changed since that version was kept/);
  } finally {
    sessions.stop = stop;
  }
  assert.equal(readFileSync(file, "utf8"), other);
  assert.deepEqual(sentMessages("stopped").map((m) => m.message), ["t1", "t2 again"]);
});
