import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-term-");
// `script` runs its command through $SHELL, so it has to be a lone path.
process.env.SHELL = "/bin/sh";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { default: express } = await import("express");
const { terminalRouter } = await import("../dist/api/terminal.js");
const { createSession } = await import("../dist/db.js");

const app = express();
app.use(express.json());
app.use("/api", terminalRouter());
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
// A failed assertion ends a test where it stands, and a server left open would keep the whole run waiting for it.
after(() => { server.closeAllConnections(); server.close(); });
const post = (url, body) =>
  fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

/** A terminal that is closed when the test ends, however it ends. */
async function openTerminal(t, body) {
  const { id } = await post("/terminal", body);
  t.after(() => fetch(`${base}/terminal/${id}`, { method: "DELETE" }));
  return id;
}

/**
 * A terminal with a shell that is up: it has answered a command, so what is sent next is read by it and not by a
 * shell that is still starting. The answer differs from the command typed, which the terminal echoes back.
 */
async function openShell(t) {
  const id = await openTerminal(t);
  await post(`/terminal/${id}/input`, { data: "echo up-$((40+2))\n" });
  assert.match(await read(id, /up-42/), /up-42/, "the shell came up");
  return id;
}

/** What the page is first sent on a connection that has output to replay: a full reset (ESC c) of its screen. */
const RESET = "\x1bc";

/** Waits until `value()` has not changed for `quietMs`: a command that is held back has stopped writing. */
async function settled(value, quietMs = 300) {
  let last = value();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    const now = value();
    if (now === last) return now;
    last = now;
  }
}

/**
 * The count a shell keeps in `file` (`echo $n > file`), as the highest value read. The shell empties the file before
 * it writes it, so a read between the two sees nothing, and a test that reads twice (once to see the count is far
 * enough, once to check it) would take that for a count of 0. The count only goes up.
 */
function counted(file) {
  let most = 0;
  return () => {
    try { most = Math.max(most, Number(readFileSync(file, "utf8")) || 0); } catch {}
    return most;
  };
}

/** Reads the terminal's stream until `until` shows up in it. */
async function read(id, until) {
  const controller = new AbortController();
  const res = await fetch(`${base}/terminal/${id}/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // An event can be longer than what one read returns: the line ends with the next newline.
  let pending = "";
  const deadline = Date.now() + 5000;
  while (!until.test(text) && Date.now() < deadline) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ done: true }), deadline - Date.now()));
    const { value, done } = await Promise.race([reader.read(), timeout]);
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith("data: ")) text += JSON.parse(line.slice(6));
    }
  }
  controller.abort();
  return text;
}

test("a shell that cannot start says so instead of taking the portal down", async (t) => {
  createSession({ id: "gone", title: "gone", workspace: path.join(home, "no-such-folder"), executor: "host" });
  const id = await openTerminal(t, { sessionId: "gone" });
  const text = await read(id, /Could not start a shell/);
  assert.match(text, /Could not start a shell/);
});

test("a resize reaches the shell without being typed into it", async (t) => {
  const id = await openShell(t);
  await post(`/terminal/${id}/resize`, { rows: 33, cols: 111 });
  // The resize is applied by a command of its own, after the portal has answered: the shell waits for the new size and says it.
  await post(`/terminal/${id}/input`, { data: `until [ "$(stty size)" = "33 111" ]; do sleep 0.05; done; echo size-$(stty size | tr ' ' x)\n` });
  const text = await read(id, /size-33x111/);
  assert.match(text, /size-33x111/);
  // The old way left the command itself on the screen.
  assert.doesNotMatch(text, /stty rows/);
});

test("what the person starts in their terminal is not marked as the agent's", async (t) => {
  // The portal marks everything it starts, for the background list to find.
  process.env.PITHAGORAS_AGENT = "1";
  const id = await openShell(t);
  await post(`/terminal/${id}/input`, { data: 'echo "mark:[${PITHAGORAS_AGENT:-none}]"\n' });
  const text = await read(id, /mark:\[(none|1)\]/);
  assert.match(text, /mark:\[none\]/);
});

test("a command that writes faster than the client reads is held back, not queued in the portal, and goes on when the client reads", async (t) => {
  const id = await openShell(t);
  const counter = path.join(home, "written");
  // 256 KiB a time, counted after each: how much the shell has been let to write.
  await post(`/terminal/${id}/input`, { data: `n=0; while :; do printf '%0262144d\\n' 0; n=$((n+1)); echo $n > ${counter}; done\n` });
  const written = counted(counter);
  // A client that is connected and does not read.
  const res = await new Promise((resolve) => http.get(`${base}/terminal/${id}/stream`, { agent: false }, (r) => { r.pause(); resolve(r); }));
  try {
    // It writes until the connection and the pipes are full, and then it is held: the count stops, and that is where it stays.
    const held = await settled(written);
    // What they hold, and nowhere near what a shell writes in that time when nothing holds it back.
    assert.ok(held > 0 && held < 256, `${held} pieces of 256 KiB were written to a client that was not reading`);
    // Nothing is to happen from here, which is only seen by waiting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(written() - held < 8, "and it does not go on");
    // Reading again lets it write.
    res.on("data", () => {});
    res.resume();
    const deadline = Date.now() + 5000;
    while (written() < held + 100 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(written() >= held + 100, "it goes on once the client reads");
  } finally {
    res.destroy();
  }
});

test("a client that goes away while the shell is held back for it does not leave the shell waiting", async (t) => {
  const id = await openShell(t);
  const counter = path.join(home, "written-away");
  await post(`/terminal/${id}/input`, { data: `n=0; while :; do printf '%0262144d\\n' 0; n=$((n+1)); echo $n > ${counter}; done\n` });
  const written = counted(counter);
  const res = await new Promise((resolve) => http.get(`${base}/terminal/${id}/stream`, { agent: false }, (r) => { r.pause(); resolve(r); }));
  try {
    const held = await settled(written);
    assert.ok(held > 0 && held < 256, "the shell is held back");
    res.destroy();
    // The shell is not ended for a while with nobody there, and nothing holds it back any more.
    const deadline = Date.now() + 5000;
    while (written() < held + 100 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(written() >= held + 100, "it goes on");
  } finally {
    res.destroy();
  }
});

/** A client of the stream that is connected and does not read, until it is told to. */
const stalledClient = (id) =>
  new Promise((resolve) => http.get(`${base}/terminal/${id}/stream`, { agent: false }, (r) => { r.pause(); resolve(r); }));

test("a client that stopped reading does not hold the shell for one that keeps up, and is let go for it", async (t) => {
  const id = await openShell(t);
  const counter = path.join(home, "written-two");
  await post(`/terminal/${id}/input`, { data: `n=0; while :; do printf '%0262144d\\n' 0; n=$((n+1)); echo $n > ${counter}; done\n` });
  // The old connection of a page whose network dropped: connected, and reading nothing.
  const stale = await stalledClient(id);
  const staleGone = new Promise((resolve) => { stale.on("close", resolve); stale.on("error", () => {}); });
  // The same page after it reconnected.
  let received = 0;
  const live = await new Promise((resolve) => http.get(`${base}/terminal/${id}/stream`, { agent: false }, (r) => { r.on("data", (chunk) => { received += chunk.length; }); resolve(r); }));
  try {
    // Held for the stale one, the shell would stand at what the pipes hold: some tens of pieces of 256 KiB.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(received > 12_000_000, `${received} bytes reached the client that was reading`);
    const before = received;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(received > before, "and it goes on");
    // The stale one was let go once it was as far behind as it may be: reading again, it gets what was queued for it and then the end.
    stale.on("data", () => {});
    stale.resume();
    await Promise.race([staleGone, new Promise((_, reject) => setTimeout(() => reject(new Error("the stale client was not let go")), 5000))]);
  } finally {
    live.destroy();
    stale.destroy();
  }
});

test("a client that is the only one and takes nothing for too long is let go, and the shell goes on without it", async (t) => {
  const id = await openShell(t);
  const counter = path.join(home, "written-dead");
  await post(`/terminal/${id}/input`, { data: `n=0; while :; do printf '%0262144d\\n' 0; n=$((n+1)); echo $n > ${counter}; done\n` });
  const written = counted(counter);
  const res = await stalledClient(id);
  const gone = new Promise((resolve) => { res.on("close", resolve); res.on("error", () => {}); });
  try {
    const held = await settled(written);
    assert.ok(held > 0 && held < 256, "the shell is held back for it at first");
    // Nothing is read from here on, and it goes on all the same once the client has been let go.
    const deadline = Date.now() + 20_000;
    while (written() < held + 100 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(written() >= held + 100, "the shell does not wait for a connection that takes nothing");
    res.on("data", () => {});
    res.resume();
    await Promise.race([gone, new Promise((_, reject) => setTimeout(() => reject(new Error("the client was not let go")), 5000))]);
  } finally {
    res.destroy();
  }
});

test("the scrollback a client that connects late is given is the end of what was written, cut to its size", async (t) => {
  const id = await openShell(t);
  // 300,000 characters in pieces, then a line to look for: the first of them cannot all be there.
  await post(`/terminal/${id}/input`, { data: "i=0; while [ $i -lt 30 ]; do printf '%010000d' $i; i=$((i+1)); done; echo; echo DONE-WRITING\n" });
  // Everything is written and the portal has it: the line is its output, not the command that the terminal echoes.
  await read(id, /00029\r?\nDONE-WRITING/);
  const text = await read(id, /00029\r?\nDONE-WRITING/);
  assert.match(text, /00029\r?\nDONE-WRITING/);
  assert.equal(text.length, RESET.length + 200_000);
});

test("a page that connects again is given the screen to start over from, so what it showed is not drawn twice", async (t) => {
  const id = await openShell(t);
  await post(`/terminal/${id}/input`, { data: "echo SHOWN-$((6*7))\n" });
  const first = await read(id, /SHOWN-42\r?\n/);
  assert.match(first, /SHOWN-42/, "the first connection showed it");
  // The page's EventSource reconnects by itself, to the same address, and writes what it is sent into the screen it has.
  const again = await read(id, /SHOWN-42\r?\n/);
  assert.ok(again.startsWith(RESET), "the replay begins with a full reset, which clears that screen");
  assert.equal(again.split("SHOWN-42").length - 1, 1, "and the output is in it once");
});

test("closing a terminal ends what it started, even what ignores the hangup", async (t) => {
  const id = await openShell(t);
  await post(`/terminal/${id}/input`, { data: "nohup sleep 300 >/dev/null 2>&1 & echo job=$!\n" });
  const pid = Number(/job=(\d+)/.exec(await read(id, /job=\d+/))?.[1]);
  assert.ok(pid > 0, "the job started");
  // What the test itself started is not left running when it fails.
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  await fetch(`${base}/terminal/${id}`, { method: "DELETE" });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!alive(), "the nohup job is gone");
});
