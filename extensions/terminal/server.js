/**
 * A shell of the person's own, in the folder of the chat it was opened from:
 * the server half of the terminal.
 *
 * Over a real pty rather than plain pipes, because a shell without one lies
 * about being interactive: no prompt, no colours, no job control. `script` from
 * util-linux allocates one and is already in the image, which beats a native
 * dependency for a feature this small.
 *
 * Output goes out over SSE and input comes back as POSTs, the same shape as
 * the chat's event stream, and no websocket library to add.
 *
 * This is shell access to the machine for anyone holding the portal's login.
 * That is already true of every chat (the agent has bash), so it grants
 * nothing new, but it is no lesser thing than the chat box beside it.
 *
 * Routes, under /api/x/pithagoras-terminal:
 *   POST   /terminal               { chat? }      → { id, cwd }
 *   GET    /terminal/:id/stream    the screen, then what the shell writes (SSE)
 *   POST   /terminal/:id/input     { data }
 *   POST   /terminal/:id/resize    { rows, cols }
 *   DELETE /terminal/:id
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

const MAX_SCROLLBACK = 200_000;

/**
 * How long a shell is kept with nobody watching it.
 *
 * The panel closes its shell when it goes, but a tab that is closed or reloaded
 * never gets to say so, and each one would leave a shell running for as long
 * as the portal does. Long enough to ride out a reload or a dropped connection.
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

/** How many /proc entries signalSession reads at once: well under any open-file limit. */
const STAT_BATCH = 256;

/** Fields of /proc/<pid>/stat after the command name, which may hold spaces: [0] is the state, [3] the session. */
const fieldsOf = (stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ");

function statOf(pid) {
  try {
    return fieldsOf(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Signals every process in a session, and says which they were.
 *
 * A walk of /proc (every process on the host), read without holding up the
 * event loop: a busy host has thousands, and a closing panel is no reason for
 * every open stream to stall. Read a batch at a time rather than one after
 * another, which on such a host kept the hangup waiting on thousands of reads.
 */
async function signalSession(session, signal) {
  let pids;
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const members = [];
  for (let i = 0; i < pids.length; i += STAT_BATCH) {
    const stats = await Promise.all(
      pids.slice(i, i + STAT_BATCH).map((pid) => readFile(`/proc/${pid}/stat`, "utf8").then((stat) => ({ pid, stat }), () => undefined)),
    );
    for (const found of stats) {
      if (!found || Number(fieldsOf(found.stat)[3]) !== session) continue;
      try {
        process.kill(Number(found.pid), signal);
        members.push(Number(found.pid));
      } catch {
        // Gone already, or not ours to signal.
      }
    }
  }
  return members;
}

export default function terminal(portal) {
  /**
   * The shells open now, by id. Each: the `script` process; the scrollback, in
   * the pieces it came in with their length (joining and cutting one string on
   * every piece copied all of it for each); who is watching; who of them has
   * no room for more; and the timer that ends it while nobody is.
   */
  const terms = new Map();

  /** Keeps `text` as the last of the scrollback, which is cut to MAX_SCROLLBACK from the front. */
  function remember(term, text) {
    term.scrollback.push(text);
    term.scrolled += text.length;
    while (term.scrollback.length > 1 && term.scrolled - term.scrollback[0].length >= MAX_SCROLLBACK) term.scrolled -= term.scrollback.shift().length;
    if (term.scrolled > MAX_SCROLLBACK) {
      const over = term.scrolled - MAX_SCROLLBACK;
      term.scrollback[0] = term.scrollback[0].slice(over);
      term.scrolled -= over;
    }
  }

  /** Gives `text` to everyone watching. */
  function deliver(term, text) {
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
  function settle(term) {
    const held = term.listeners.size > 0 && term.waiting.size >= term.listeners.size;
    for (const out of [term.proc.stdout, term.proc.stderr]) {
      if (held) out?.pause();
      else out?.resume();
    }
  }

  function hold(term, listener) {
    term.waiting.add(listener);
    settle(term);
  }

  function release(term, listener) {
    if (term.waiting.delete(listener)) settle(term);
  }

  /** The shell `script` started: the child that leads the session on the pty. */
  function shellOf(term) {
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
   * The session the shell leads; the id stays after the shell itself is gone.
   * Never the portal's own: signalled, that would take the portal down with it.
   */
  function sessionOf(shell) {
    const session = Number(statOf(shell)?.[3]);
    return session > 0 && session !== Number(statOf(process.pid)?.[3]) ? session : undefined;
  }

  /**
   * Ends the shell, and whatever it started.
   *
   * Signalled directly rather than through `script`: util-linux 2.39 (Debian)
   * ignores a hangup, so every closed panel left its shell running. The shell
   * is in a session of its own on the pty, jobs included, so a hangup to all
   * of it is what closing a real terminal does, and the shell is gone at once.
   * What ignores that, a `nohup` job, is killed a moment later: only what the
   * hangup found, and only if it is still there. Where the session cannot be
   * found, `script` is terminated and the rest left to the hangup.
   *
   * The shell has its hangup at once, and passes it on to the jobs it knows of;
   * the rest of the session has it once the walk has found them. `script` is
   * terminated only after that: gone first, it takes the pty with it, and what
   * the walk is still looking for has been left to itself in the meantime.
   */
  function end(term) {
    clearTimeout(term.reaper);
    let done = Promise.resolve();
    if (!term.exited) {
      // Read once: a second look could find the shell gone, and the two answers disagree.
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

  function watchUnattended(term) {
    clearTimeout(term.reaper);
    if (term.listeners.size) return;
    term.reaper = setTimeout(() => end(term), UNWATCHED_MS);
    term.reaper.unref();
  }

  /**
   * The pty the shell is on: `script` holds the master, its child the other end.
   * Linux only, through /proc. Undefined anywhere it cannot be found, and the
   * caller falls back.
   */
  function ptyOf(term) {
    const shell = shellOf(term);
    try {
      const tty = shell ? readlinkSync(`/proc/${shell}/fd/0`) : "";
      return tty.startsWith("/dev/pts/") ? tty : undefined;
    } catch {
      return undefined;
    }
  }

  function create(cwd) {
    const id = randomUUID().slice(0, 8);
    // -q quiet, -f flush on every write so output is not held back, -e return the
    // command's exit status, and /dev/null because we want the pty, not a log.
    const proc = spawn("script", ["-qfec", process.env.SHELL || "bash -il", "/dev/null"], {
      cwd,
      // Without the agent's mark: what the person starts here (tmux, a server
      // under setsid) is theirs, and not a job for the chat to list and stop.
      env: { ...portal.sandbox.personEnv(), TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const term = { id, proc, scrollback: [], scrolled: 0, listeners: new Set(), waiting: new Set(), exited: false, reaper: undefined };
    // A folder that is gone, or no `script` on this machine. Unhandled, the
    // spawn failure is thrown from the process object and takes the portal down.
    proc.on("error", (e) => {
      term.exited = true;
      const text = `\r\nCould not start a shell: ${e.message}\r\n`;
      remember(term, text);
      deliver(term, text);
    });

    const push = (chunk) => {
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

  const router = portal.router;
  const json = portal.http.json({ limit: "2mb" });

  /** Opens a shell, in the folder of a chat when one is named, and the home folder otherwise. */
  router.post("/terminal", json, (req, res) => {
    const chat = typeof req.body?.chat === "string" ? req.body.chat : "";
    let cwd = process.env.HOME || "/";
    if (chat) {
      try {
        cwd = portal.chats.folder(chat);
      } catch {
        // A chat that is gone, or whose folder is: a shell where the person's own files are.
      }
    }
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

    let stall;
    /** Ends this client's stream; its page opens a new one, and is given the scrollback to start over from. */
    const drop = () => res.destroy();
    const send = (chunk) => {
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
    // The shell goes on and its page is shown to the next login: the stream is for the login it was opened under.
    const unwatch = portal.http.endWithLogin(drop);
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

  router.post("/terminal/:id/input", json, (req, res) => {
    const term = terms.get(req.params.id);
    if (!term || term.exited) return res.status(404).json({ error: "No such terminal" });
    if (typeof req.body?.data === "string") term.proc.stdin?.write(req.body.data);
    res.json({ ok: true });
  });

  /**
   * Tell the pty its new size.
   *
   * With stty from outside, on the shell's own tty: the kernel then tells
   * whatever is in front (the shell, vim, top) that the window changed.
   * Typing `stty` into the shell instead puts the command on the screen and in
   * the history on every resize, and into whatever program has the keyboard.
   * That remains the fallback where the tty cannot be found.
   */
  router.post("/terminal/:id/resize", json, (req, res) => {
    const term = terms.get(req.params.id);
    const size = (v, fallback) => {
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

  /**
   * Stopped (the portal is stopping, or the package was switched off): every
   * shell ends. The shells live on the pty in sessions of their own, so a
   * stopped portal would leave them running for init, with whatever they
   * started holding its port and memory, and no panel left to close it.
   * Resolves when the last has been given its two seconds.
   */
  return () => Promise.all([...terms.values()].map(end)).then(() => {});
}
