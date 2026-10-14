import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import express, { type Router } from "express";
import { getSession } from "../db.js";
import { watchStream } from "../login-streams.js";
import { MARKER } from "../background.js";
import { signalSession, statOf } from "../proc-stat.js";

/**
 * A shell, in the portal.
 *
 * Over a real pty rather than plain pipes, because a shell without one lies
 * about being interactive: no prompt, no colours, no job control. `script` from
 * util-linux allocates one and is already in the image, which beats a native
 * dependency for a feature this small.
 *
 * Output goes out over SSE and input comes back as POSTs — the same shape as
 * the session event stream, and no websocket library to add.
 *
 * This is shell access to the container for anyone holding the portal
 * password. That is already true of every session — the agent has bash — so it
 * grants nothing new, but it is worth being clear that it is not a lesser
 * thing than the chat box beside it.
 */

const MAX_SCROLLBACK = 200_000;

/**
 * How long a shell is kept with nobody watching it.
 *
 * The panel closes its shell when it goes, but a tab that is closed or reloaded
 * never gets to say so, and each one used to leave a shell running for as long
 * as the portal did. Long enough to ride out a reload or a dropped connection.
 */
const UNWATCHED_MS = 5 * 60_000;

/**
 * How long a client may sit on what it was sent before it is let go. A page
 * whose network dropped, or that a phone suspended, keeps its connection and
 * takes nothing from it, possibly for a quarter of an hour; its page opens a
 * new one and is given the scrollback, which is all it would have missed.
 */
const STALL_MS = 10_000;

/** What a client that is behind may have queued while another keeps up, before it is let go for it. */
const MAX_BEHIND = 4_000_000;

/** A client of the stream: takes what the shell wrote, and says whether it has room for more. */
type Listener = (chunk: string) => boolean;

interface Term {
  id: string;
  proc: ChildProcess;
  /**
   * What was written last, replayed to a client that connects late, so a reload
   * keeps the screen. In the pieces it came in, with their length: joining and
   * cutting one string on every piece copied all of it for each.
   */
  scrollback: string[];
  scrolled: number;
  listeners: Set<Listener>;
  /** The listeners that did not have room for what they were given, and have not said they have since. */
  waiting: Set<Listener>;
  exited: boolean;
  /** Set while nobody is attached; ends the shell if nobody comes back. */
  reaper?: NodeJS.Timeout;
}

const terms = new Map<string, Term>();

/** Keeps `text` as the last of the scrollback, which is cut to MAX_SCROLLBACK from the front. */
function remember(term: Term, text: string): void {
  term.scrollback.push(text);
  term.scrolled += text.length;
  while (term.scrollback.length > 1 && term.scrolled - term.scrollback[0].length >= MAX_SCROLLBACK) term.scrolled -= term.scrollback.shift()!.length;
  if (term.scrolled > MAX_SCROLLBACK) {
    const over = term.scrolled - MAX_SCROLLBACK;
    term.scrollback[0] = term.scrollback[0].slice(over);
    term.scrolled -= over;
  }
}

/** Gives `text` to everyone watching, and holds the shell back for any that cannot take it yet. */
function deliver(term: Term, text: string): void {
  for (const listener of term.listeners) listener(text);
}

/**
 * The shell is held while every client is behind: a command that writes faster
 * than the connection takes it would otherwise be read as fast as it can write,
 * and queued in the portal's memory, until there is no more of it. Not read,
 * the pipe fills, and `script` and the command with it wait, as at a terminal.
 * One that keeps up does not wait for one that does not: that one is let go
 * when it has been behind too long or too far.
 */
function settle(term: Term): void {
  const held = term.listeners.size > 0 && term.waiting.size >= term.listeners.size;
  for (const out of [term.proc.stdout, term.proc.stderr]) {
    if (held) out?.pause();
    else out?.resume();
  }
}

function hold(term: Term, listener: Listener): void {
  term.waiting.add(listener);
  settle(term);
}

function release(term: Term, listener: Listener): void {
  if (term.waiting.delete(listener)) settle(term);
}

/**
 * Ends the shell, and whatever it started.
 *
 * Signalled directly rather than through `script`: util-linux 2.39 (Debian,
 * the LXC image) ignores a hangup, so every closed panel left its shell
 * running — and the test that closes one waited on it forever. The shell is in
 * a session of its own on the pty, jobs included, so a hangup to all of it is
 * what closing a real terminal does, and the shell is gone at once. What
 * ignores that, a `nohup` job, is killed a moment later — only what the
 * hangup found, and only if it is still there. Where the session cannot be
 * found, `script` is terminated and the rest left to the hangup.
 *
 * The shell has its hangup at once, and passes it on to the jobs it knows of;
 * the rest of the session has it once the walk has found them. `script` is
 * terminated only after that: gone first, it takes the pty with it, and what
 * the walk is still looking for has been left to itself in the meantime.
 */
function end(term: Term): Promise<void> {
  clearTimeout(term.reaper);
  let done: Promise<void> = Promise.resolve();
  if (!term.exited) {
    // Read once: a second look could find the shell gone, and the two
    // answers disagree.
    const shell = shellOf(term);
    const session = shell ? sessionOf(shell) : undefined;
    if (shell && session) {
      try {
        process.kill(shell, "SIGHUP");
      } catch {
        // Gone already; the walk finds whatever it left.
      }
    }
    const members = session ? signalSession(session, "SIGHUP") : Promise.resolve([]);
    void members.then(() => {
      if (!term.exited) term.proc.kill("SIGTERM");
    });
    done = new Promise((resolve) => {
      setTimeout(() => {
        if (!term.exited) term.proc.kill("SIGKILL");
        void members
          .then((pids) => {
            for (const pid of pids) {
              // Still in that session: a pid given to something else since is not.
              if (Number(statOf(pid)?.[3]) !== session) continue;
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // Gone in the meantime.
              }
            }
          })
          .then(resolve);
      }, 2000).unref();
    });
  }
  terms.delete(term.id);
  return done;
}

/**
 * Ends every shell, for a portal that is stopping. The shells are the portal's
 * children but live on the pty in sessions of their own, so a stopped portal
 * leaves them running for init, with whatever they started: a dev server or a
 * build, holding its port and memory, with no panel left to close it. Resolves
 * when the last has been given its two seconds.
 */
export function endAllTerminals(): Promise<void> {
  return Promise.all([...terms.values()].map(end)).then(() => {});
}

/** The shell `script` started: the child that leads the session on the pty. */
function shellOf(term: Term): number | undefined {
  const pid = term.proc.pid;
  if (!pid) return undefined;
  try {
    const [child] = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/);
    return child ? Number(child) : undefined;
  } catch {
    return undefined;
  }
}


/**
 * The session the shell leads — the id stays after the shell itself is gone.
 * Never the portal's own: signalled, that would take the portal down with it.
 */
function sessionOf(shell: number): number | undefined {
  const session = Number(statOf(shell)?.[3]);
  return session > 0 && session !== Number(statOf(process.pid)?.[3]) ? session : undefined;
}

function watchUnattended(term: Term): void {
  clearTimeout(term.reaper);
  if (term.listeners.size) return;
  term.reaper = setTimeout(() => end(term), UNWATCHED_MS);
  term.reaper.unref();
}

/**
 * The pty the shell is on: `script` holds the master, its child the other end.
 *
 * Linux only, through /proc, which is where the portal runs. Undefined anywhere
 * it cannot be found, and the caller falls back.
 */
function ptyOf(term: Term): string | undefined {
  const shell = shellOf(term);
  try {
    const tty = shell ? readlinkSync(`/proc/${shell}/fd/0`) : "";
    return tty.startsWith("/dev/pts/") ? tty : undefined;
  } catch {
    return undefined;
  }
}

/** The portal's environment less MARKER, which everything else it starts carries. */
export function personsEnv(): NodeJS.ProcessEnv {
  const { [MARKER.split("=")[0]]: _mark, ...env } = process.env;
  return env;
}

function create(cwd: string): Term {
  const id = randomUUID().slice(0, 8);
  // -q quiet, -f flush on every write so output is not held back, -e return the
  // command's exit status, and /dev/null because we want the pty, not a log.
  const proc = spawn("script", ["-qfec", process.env.SHELL || "bash -il", "/dev/null"], {
    cwd,
    // Without the agent's mark: what the person starts here — tmux, a server
    // under setsid — is theirs, and not a job for the chat to list and stop.
    env: { ...personsEnv(), TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const term: Term = { id, proc, scrollback: [], scrolled: 0, listeners: new Set(), waiting: new Set(), exited: false };
  // A folder that is gone, or no `script` on this machine. Unhandled, the
  // spawn failure is thrown from the process object and takes the portal down.
  proc.on("error", (e) => {
    term.exited = true;
    const text = `\r\nCould not start a shell: ${e.message}\r\n`;
    remember(term, text);
    deliver(term, text);
  });

  const push = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    remember(term, text);
    deliver(term, text);
  };
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);
  proc.on("exit", () => {
    term.exited = true;
    const text = "\r\n[session ended]\r\n";
    remember(term, text);
    deliver(term, text);
  });

  terms.set(id, term);
  watchUnattended(term);
  return term;
}

export function terminalRouter(): Router {
  const router = express.Router();

  /** Opens a shell, in the workspace of a session when one is named. */
  router.post("/terminal", (req, res) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    const cwd = (sessionId && getSession(sessionId)?.workspace) || process.env.HOME || "/";
    const term = create(cwd);
    res.json({ id: term.id, cwd });
  });

  router.get("/terminal/:id/stream", (req, res) => {
    const term = terms.get(req.params.id);
    if (!term) return res.status(404).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let stall: NodeJS.Timeout | undefined;
    /** Ends this client's stream; its page opens a new one, and is given the scrollback to start over from. */
    const drop = () => res.destroy();
    const send: Listener = (chunk) => {
      const room = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (room) return true;
      if (!term.waiting.has(send)) {
        hold(term, send);
        stall = setTimeout(drop, STALL_MS);
        res.once("drain", () => {
          clearTimeout(stall);
          release(term, send);
        });
      } else if (res.writableLength > MAX_BEHIND) {
        drop();
      }
      return false;
    };
    term.listeners.add(send);
    // What is already on screen, so reconnecting does not show an empty shell. After a full reset (ESC c): a
    // page that reconnects still has what it showed, and the replay, which can start in the middle of an
    // escape sequence, is the whole screen, not more of it.
    if (term.scrolled) send("\x1bc" + term.scrollback.join(""));
    watchUnattended(term);
    // Without traffic a proxy takes an idle shell for a dead connection.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    // The shell goes on and its page is shown to the next login: the stream is for the password it was opened under.
    const unwatch = watchStream(drop);
    req.on("close", () => {
      unwatch();
      clearInterval(heartbeat);
      clearTimeout(stall);
      term.listeners.delete(send);
      // Gone, it will not drain: the shell is not to wait for it.
      release(term, send);
      settle(term);
      watchUnattended(term);
    });
  });

  router.post("/terminal/:id/input", (req, res) => {
    const term = terms.get(req.params.id);
    if (!term || term.exited) return res.status(404).json({ error: "No such terminal" });
    if (typeof req.body?.data === "string") term.proc.stdin?.write(req.body.data);
    res.json({ ok: true });
  });

  /**
   * Tell the pty its new size.
   *
   * With stty from outside, on the shell's own tty: the kernel then tells
   * whatever is in front — the shell, vim, top — that the window changed.
   * Typing `stty` into the shell instead put the command on the screen and in
   * the history on every resize, and into whatever program had the keyboard.
   * That remains the fallback where the tty cannot be found.
   */
  router.post("/terminal/:id/resize", (req, res) => {
    const term = terms.get(req.params.id);
    const size = (v: unknown, fallback: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 2 && n <= 1000 ? n : fallback;
    };
    const rows = size(req.body?.rows, 24);
    const cols = size(req.body?.cols, 80);
    if (!term || term.exited) return res.status(404).json({ error: "No such terminal" });
    const tty = ptyOf(term);
    if (tty) {
      execFile("stty", ["-F", tty, "rows", String(rows), "cols", String(cols)], () => {});
    } else {
      term.proc.stdin?.write(`stty rows ${rows} cols ${cols} 2>/dev/null\n`);
    }
    res.json({ ok: true });
  });

  router.delete("/terminal/:id", (req, res) => {
    const term = terms.get(req.params.id);
    if (term) end(term);
    res.json({ ok: true });
  });

  return router;
}
