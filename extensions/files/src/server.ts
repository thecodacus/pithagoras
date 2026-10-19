import { spawn, type ChildProcessByStdio, type StdioOptions } from "node:child_process";
import { closeSync, createReadStream } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Request, RequestHandler, Response, Router } from "express";
import type { FolderWatch, ServerPortal } from "@pithagoras/extension-api/server";

/**
 * Files' server half: its routes at /api/x/pithagoras-files/chats/<chat>/…,
 * for listing, reading, downloading, saving, renaming and deleting what is in
 * the chat's folder, uploading a file into it, a new folder in it, and the whole of it as a .tar.gz;
 * and the folder a page has open, watched, so that a change made by anything shows (see `watchFolders`).
 *
 * What may be reached and how it is read and written is the portal's
 * (`portal.files`): the agent writes in that folder, links included, and these
 * routes run in the portal's own process. This only turns a chat into its
 * folder, a request into a call, and a refusal into a status. Pictures are
 * the portal's own routes, which its message box and its conversation use as well.
 */

type Files = ServerPortal["files"];

/** Left out of a folder's archive: regenerable, or huge, and not the work itself. */
export const ARCHIVE_EXCLUDES = ["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"];

/** A refusal's status, by its code (see FileRefusal). */
const STATUS: Record<string, number> = { invalid: 400, missing: 404, conflict: 409, exists: 409, too_large: 413, failed: 500, unsaved: 409 };

/** A refusal of the portal's as a status and its words; anything else is a 500, said in the log. */
function fail(res: Response, e: unknown) {
  const code = (e as { code?: unknown })?.code;
  if (e instanceof Error && typeof code === "string" && code in STATUS) {
    const unsaved = (e as { unsaved?: unknown }).unsaved;
    // Told apart from the other 409s by its code, so that the page can ask about it instead of showing an error.
    if (code === "unsaved" && unsaved) return res.status(STATUS.unsaved).json({ error: e.message, code: "unsaved-work", unsaved });
    // With its code: the page tells a conflict from "exists" (both 409) by that, not by the sentence.
    return res.status(STATUS[code]).json({ error: e.message, code });
  }
  console.error("[files]", e);
  res.status(500).json({ error: "Could not read or change the files" });
}

const pathOf = (req: Request) => String(req.query.path ?? "");

export default function files(portal: ServerPortal) {
  routes(portal.router, portal.http.json(), portal.files, (id) => portal.chats.folder(id));
  watchFolders(portal);
}

/** The topic of a folder of a chat's, as the page names it: `dir/<chat>/<path in the chat's folder>`, both parts encoded (`folderTopic`, files-api.ts). */
const FOLDER_TOPIC = /^dir\/([^/]+)\/(.*)$/s;

/**
 * The folder a page has open, watched for as long as one listens (`portal.files.watch`, `portal.onListen`): a page that
 * listens to the topic of a folder is told, once a burst of changes is over, that something in it changed, whatever
 * changed it (the Terminal, a command the agent ran, a person by hand), and looks at the folder again. It is told
 * nothing else: the names are read through the routes, which have the checks.
 *
 * The watch is the portal's own, on the folder as it was opened, so a link put in its place does not lead it elsewhere. A folder
 * that was removed, replaced, not there yet or cannot be watched is tried again every `retryMs`, and a page is told when
 * it is watched again; a system that cannot watch at all leaves the page to its other ways (the agent's own reads and writes).
 */
export function watchFolders(portal: ServerPortal, retryMs = 2000): void {
  interface Watched {
    topic: string;
    base: string;
    rel: string;
    count: number;
    watch: FolderWatch | null;
    timer: ReturnType<typeof setInterval> | null;
  }
  const open = new Map<string, Watched>();

  /** Sets the watch on the folder as it is now. True if it is set; a path the portal refuses (out of the folder) is thrown. */
  const set = (w: Watched): boolean => {
    try {
      w.watch = portal.files.watch(
        w.base,
        w.rel,
        ({ gone }) => {
          if (open.get(w.topic) !== w) return;
          // The folder itself was removed or replaced: this watch is over, and the one that is there now is watched at once.
          if (gone) {
            w.watch = null;
            try {
              set(w);
            } catch {
              // Out of the chat's folder now (a link in the way): not watched.
            }
          }
          portal.push(w.topic, { changed: true });
        },
        { debounceMs: 100 },
      );
      return true;
    } catch (e) {
      w.watch = null;
      if ((e as { code?: unknown })?.code === "invalid") throw e;
      // Missing for now, or not to be watched here: the next look at it tries again.
      return false;
    }
  };

  /** Watches again a folder that is not watched, or not the one that was; tells the page, which may have missed what happened meanwhile. */
  const tryAgain = (w: Watched): void => {
    if (w.watch?.current()) return;
    w.watch?.close();
    try {
      if (set(w)) portal.push(w.topic, { changed: true });
    } catch {
      // Out of the chat's folder now (a link in the way): not watched.
    }
  };

  portal.onListen((topic, page) => {
    const named = FOLDER_TOPIC.exec(topic);
    if (!named) return false;
    let w = open.get(topic);
    if (!w) {
      let base: string;
      let rel: string;
      try {
        base = portal.chats.folder(decodeURIComponent(named[1]));
        rel = decodeURIComponent(named[2]);
      } catch {
        // A chat that is gone, or a topic that is not one of ours.
        return false;
      }
      const made: Watched = { topic, base, rel, count: 0, watch: null, timer: null };
      try {
        set(made);
      } catch {
        // A path that leads out of the chat's folder is not for a page to watch.
        return false;
      }
      made.timer = setInterval(() => tryAgain(made), retryMs);
      made.timer.unref?.();
      open.set(topic, made);
      w = made;
    }
    const mine = w;
    mine.count++;
    // Where things stand: the page looks at the folder as it begins to listen, and again after a connection that dropped.
    page.send({ first: true });
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--mine.count > 0) return;
      if (mine.timer) clearInterval(mine.timer);
      mine.watch?.close();
      if (open.get(topic) === mine) open.delete(topic);
    };
  });
}

/** The routes, on `router` (the package's): `json` reads a body, `folderOf` is a chat's folder or throws. */
export function routes(router: Router, json: RequestHandler, files: Files, folderOf: (id: string) => string) {
  /** The chat's folder, or the answer that it has none. */
  const base = (req: Request, res: Response): string | undefined => {
    try {
      return folderOf(String(req.params.id));
    } catch (e) {
      // A chat that is gone, or whose folder is.
      res.status(404).json({ error: (e as Error).message || "Not found" });
      return undefined;
    }
  };

  router.get("/chats/:id/files", (req, res) => {
    const at = base(req, res);
    if (!at) return;
    try {
      res.json(files.list(at, pathOf(req)));
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/chats/:id/file", (req, res) => {
    const at = base(req, res);
    if (!at) return;
    try {
      if (req.query.download !== "1") return void res.json(files.read(at, pathOf(req)));
      // Sent from the descriptor that was checked, not from the path again.
      const { fd, size, name } = files.open(at, pathOf(req));
      res.attachment(name);
      res.setHeader("Content-Length", size);
      if (size === 0) {
        closeSync(fd);
        return void res.end();
      }
      // Up to the size that was announced, even if the file has grown since.
      const stream = createReadStream("", { fd, start: 0, end: size - 1 });
      let sent = 0;
      stream.on("data", (chunk) => (sent += chunk.length));
      // Shrunk since, the body would end short of the length announced and a client would wait for the rest: the
      // connection is cut instead, so the download fails at once.
      stream.on("end", () => {
        if (sent < size) {
          console.error(`[files] ${name} changed while it was sent (${sent} of ${size} bytes)`);
          res.destroy();
        }
      });
      stream.on("error", (e) => {
        console.error("[files] download failed:", e.message);
        res.destroy();
      });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (e) {
      fail(res, e);
    }
  });

  router.put("/chats/:id/file", json, (req, res) => {
    const at = base(req, res);
    if (!at) return;
    const { content, mtime, create } = req.body ?? {};
    if (typeof content !== "string") return res.status(400).json({ error: "content is required" });
    if (mtime !== undefined && typeof mtime !== "number") return res.status(400).json({ error: "mtime must be a number" });
    try {
      res.json({ ok: true, ...files.write(at, pathOf(req), content, { expected: mtime, create: create === true }) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.patch("/chats/:id/file", json, (req, res) => {
    const at = base(req, res);
    if (!at) return;
    try {
      res.json({ ok: true, path: files.rename(at, pathOf(req), req.body?.name) });
    } catch (e) {
      fail(res, e);
    }
  });

  /** A new folder, named `name`, in the folder at `path`. */
  router.post("/chats/:id/folder", json, (req, res) => {
    const at = base(req, res);
    if (!at) return;
    try {
      res.json({ ok: true, path: files.makeFolder(at, pathOf(req), req.body?.name) });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * A file from this computer, as the request body, into the folder at `path` under `name`: a taken name gets a number
   * rather than being replaced. The portal streams it to disk and puts it in place when all of it came (`files.upload`).
   */
  router.post("/chats/:id/upload", async (req, res) => {
    // Any answer given before the whole file came in closes the connection, an early refusal included: kept open, Node
    // would read the rest of the body, however big, just to throw it away.
    res.setHeader("Connection", "close");
    res.on("finish", () => {
      if (!req.complete) req.destroy();
    });
    const at = base(req, res);
    if (!at) return;
    try {
      const stored = await files.upload(at, pathOf(req), String(req.query.name ?? ""), req);
      res.removeHeader("Connection");
      res.json({ ok: true, ...stored });
    } catch (e) {
      if (res.headersSent || res.destroyed) return void req.destroy();
      fail(res, e);
    }
  });

  /** What deleting `path` would lose that nothing else has, so the question can name it: `{ unsaved }`, null for nothing. */
  router.get("/chats/:id/unsaved", async (req, res) => {
    const at = base(req, res);
    if (!at) return;
    try {
      res.json({ unsaved: await files.unsaved(at, pathOf(req)) });
    } catch (e) {
      fail(res, e);
    }
  });

  /** `discard=1` says that git work the folder holds, which nothing else has, may go with it. */
  router.delete("/chats/:id/file", async (req, res) => {
    const at = base(req, res);
    if (!at) return;
    try {
      await files.remove(at, pathOf(req), { discard: req.query.discard === "1" });
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * The folder — the chat's, or one inside it with `path` — as a .tar.gz,
   * streamed out of `tar` rather than staged on disk first: a big project would
   * need the space twice, and a clean-up.
   */
  router.get("/chats/:id/archive", (req, res) => {
    const at = base(req, res);
    if (!at) return;
    // Held open: tar is given this very folder, not a path that a link put there since the check could lead elsewhere.
    let held: ReturnType<Files["hold"]>;
    try {
      held = files.hold(at, pathOf(req));
    } catch (e) {
      return fail(res, e);
    }
    const name = (held.name || path.basename(at)).replace(/[^a-zA-Z0-9_.-]/g, "_") || "workspace";
    let tar: ChildProcessByStdio<null, Readable, Readable>;
    try {
      const stdio: StdioOptions = ["ignore", "pipe", "pipe", ...(held.fd === undefined ? [] : [held.fd])];
      tar = spawn("tar", ["-czf", "-", ...ARCHIVE_EXCLUDES.map((d) => `--exclude=${d}`), "-C", held.inChild(3), "."], { stdio }) as ChildProcessByStdio<null, Readable, Readable>;
    } finally {
      // The child has its own copy of the descriptor from here on, or none if it did not start.
      held.close();
    }
    // Not announced until tar has made something: a tar that cannot start, or dies at once, is then an error the
    // person is told of, not a file of zero bytes that the browser calls finished.
    let started = false;
    // Answered already, by an error: whatever tar does after that is not heard.
    let answered = false;
    let complaints = "";
    tar.stderr.on("data", (chunk) => {
      if (complaints.length < 2_000) complaints += chunk;
    });
    const begin = () => {
      started = true;
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.tar.gz"`);
    };
    tar.stdout.once("data", (first: Buffer) => {
      begin();
      res.write(first);
      // Not ended by the pipe: how tar ended decides how this one does, below.
      tar.stdout.pipe(res, { end: false });
    });
    tar.on("error", (e) => {
      console.error("[files] archive: could not run tar:", e.message);
      answered = true;
      if (started) res.destroy();
      else res.status(500).json({ error: "Could not make the archive: tar is not available" });
    });
    tar.on("close", (code) => {
      // Already answered, or killed because nobody was waiting any more.
      if (answered || code === null || res.destroyed) return;
      answered = true;
      // 1 is "a file changed or vanished while it was read": what was read is in the archive, and that is the
      // ordinary way a busy folder ends. Anything else means the archive is not the folder, so the download is cut
      // off and fails, rather than ending as if it were whole.
      if (code > 1) {
        console.error(`[files] archive: tar exited ${code}: ${complaints.trim()}`);
        if (started) return void res.destroy();
        return void res.status(500).json({ error: "Could not make the archive" });
      }
      if (!started) begin();
      res.end();
    });
    // Nobody is waiting any more.
    res.on("close", () => tar.kill());
  });
}
