import { spawn } from "node:child_process";
import { closeSync, createReadStream, createWriteStream, fstatSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type Router } from "express";
import { getSession } from "../db.js";
import { unsavedRefusal } from "../git.js";
import {
  ARCHIVE_EXCLUDES,
  FileError,
  baseDir,
  listDir,
  folderPath,
  makeFolder,
  uploadTarget,
  openDownload,
  openPicture,
  readText,
  removeEntry,
  unsavedAt,
  renameEntry,
  writeText,
} from "../workspace-files.js";

/**
 * The files in a chat's folder, for the Files panel.
 *
 * Keyed by chat, not by folder name: a chat can be in a project, in the
 * workspace root, or in Home, which is outside it, and "the folder this chat
 * works in" is the one thing that is the same for all of them. Everything that
 * decides what may be reached is in workspace-files.ts; this only turns a chat
 * into its folder and a refusal into a status.
 */

/** An upload larger than this is cut off: the portal's disk is everyone's. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const STATUS = { invalid: 400, missing: 404, conflict: 409, exists: 409, too_large: 413, failed: 500, unsaved: 409 } as const;

export function fail(res: Response, e: unknown) {
  // Told apart from the other 409s by its code, so that the page can ask about it instead of showing an error.
  if (e instanceof FileError && e.unsaved) return res.status(STATUS[e.code]).json(unsavedRefusal(e.unsaved));
  // With its code: the page tells a conflict from "exists" (both 409) by that, not by the sentence.
  if (e instanceof FileError) return res.status(STATUS[e.code]).json({ error: e.message, code: e.code });
  console.error("[portal] files:", e);
  res.status(500).json({ error: "Could not read or change the files" });
}

/**
 * Sends a picture that was opened by openPicture: its bytes as the type they
 * say, under a policy that would stop it running anything even if a browser
 * disagreed. The descriptor is read to the size that was announced and closed
 * with the response. `cache` is what the browser may keep it for.
 */
export function sendPicture(req: Request, res: Response, opened: ReturnType<typeof openPicture>, cache: string): void {
  const { fd, size, mimeType } = opened;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", cache);
  const modified = fstatSync(fd).mtime;
  res.setHeader("ETag", `W/"${size.toString(16)}-${modified.getTime().toString(16)}"`);
  res.setHeader("Last-Modified", modified.toUTCString());
  if (req.fresh) {
    closeSync(fd);
    return void res.status(304).end();
  }
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", size);
  const stream = createReadStream("", { fd, start: 0, end: Math.max(0, size - 1) });
  stream.on("error", (e) => {
    console.error("[portal] files: picture failed:", e.message);
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export function filesRouter(): Router {
  const router = express.Router();

  /** The chat's folder, or the answer that it has none. */
  const folderOf = (id: string, res: Response): string | undefined => {
    const session = getSession(id);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return undefined;
    }
    try {
      return baseDir(session.workspace);
    } catch (e) {
      fail(res, e);
      return undefined;
    }
  };

  router.get("/sessions/:id/files", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    try {
      res.json(listDir(base, req.query.path));
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/sessions/:id/file", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    try {
      if (req.query.download === "1") {
        // Sent from the descriptor that was checked, not from the path again: see openDownload.
        const { fd, size, name } = openDownload(base, req.query.path);
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
        // If it has shrunk since, the body ends short of the length that was
        // announced, and a client waits for the rest until it gives up. The
        // connection is cut instead, so the download fails at once.
        stream.on("end", () => {
          if (sent < size) {
            console.error(`[portal] files: ${name} changed while it was sent (${sent} of ${size} bytes)`);
            res.destroy();
          }
        });
        stream.on("error", (e) => {
          console.error("[portal] files: download failed:", e.message);
          res.destroy();
        });
        res.on("close", () => stream.destroy());
        return void stream.pipe(res);
      }
      res.json(readText(base, req.query.path));
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * A picture in the folder, drawn in the page rather than downloaded: for the
   * Files panel, a canvas that shows one, and what the agent puts in front of
   * the person with show_image. Only what its bytes say is a picture is sent,
   * with that type, and under a policy that would stop it running anything
   * even if a browser disagreed.
   */
  router.get("/sessions/:id/picture", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    let opened: ReturnType<typeof openPicture>;
    try {
      opened = openPicture(base, req.query.path);
    } catch (e) {
      return fail(res, e);
    }
    // The agent rewrites files in place, so the browser asks every time — and
    // is told it already has it unless the file changed.
    sendPicture(req, res, opened, "private, no-cache");
  });

  router.put("/sessions/:id/file", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    const { content, mtime, create } = req.body ?? {};
    if (typeof content !== "string") return res.status(400).json({ error: "content is required" });
    if (mtime !== undefined && typeof mtime !== "number") return res.status(400).json({ error: "mtime must be a number" });
    try {
      res.json({ ok: true, ...writeText(base, req.query.path, content, mtime, create === true) });
    } catch (e) {
      fail(res, e);
    }
  });

  /** A new folder, named `name`, in the folder at `path`. */
  router.post("/sessions/:id/folder", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    try {
      res.json({ ok: true, path: makeFolder(base, req.query.path, req.body?.name) });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * A file from the browser, as the request body, into the folder at `path`
   * under `name` — or "name (2)" if that is taken. Streamed to disk, so a big
   * file is never held in memory, and only put in place once all of it came.
   */
  router.post("/sessions/:id/upload", (req, res) => {
    // Any answer given before the whole file came in closes the connection, the
    // early refusals below included: kept open, Node would read the rest of the
    // body — however big it said it was — just to throw it away.
    res.setHeader("Connection", "close");
    res.on("finish", () => {
      if (!req.complete) req.destroy();
    });
    const base = folderOf(req.params.id, res);
    if (!base) return;
    const announced = Number(req.headers["content-length"]);
    if (announced > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Files over ${MAX_UPLOAD_BYTES / 1024 / 1024 / 1024} GB are not uploaded here` });
    }
    let target: ReturnType<typeof uploadTarget>;
    try {
      target = uploadTarget(base, req.query.path, req.query.name);
    } catch (e) {
      return fail(res, e);
    }
    const out = createWriteStream("", { fd: target.fd });
    let received = 0;
    let done = false;
    const giveUp = (status: number, error: string) => {
      if (done) return;
      done = true;
      req.unpipe(out);
      out.destroy();
      target.abandon();
      // Nothing more of the body is read: the connection is closed once the
      // answer is out, rather than taking in the rest of a file nobody keeps.
      if (res.headersSent) return void req.destroy();
      res.status(status).json({ error });
    };
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) giveUp(413, `Files over ${MAX_UPLOAD_BYTES / 1024 / 1024 / 1024} GB are not uploaded here`);
    });
    // The browser went away, or the connection dropped: half a file is not a file.
    req.on("aborted", () => giveUp(400, "The upload was interrupted"));
    out.on("error", (e) => {
      console.error("[portal] files: upload failed:", e.message);
      giveUp(500, "The file could not be written");
    });
    out.on("finish", () => {
      if (done) return;
      done = true;
      try {
        res.removeHeader("Connection");
        res.json({ ok: true, path: target.finish(), size: received });
      } catch (e) {
        fail(res, e);
      }
    });
    req.pipe(out);
  });

  router.patch("/sessions/:id/file", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    try {
      res.json({ ok: true, path: renameEntry(base, req.query.path, req.body?.name) });
    } catch (e) {
      fail(res, e);
    }
  });

  /** What deleting `path` would lose that nothing else has, so the question can name it: `{ unsaved }`, null for nothing. */
  router.get("/sessions/:id/unsaved", async (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    try {
      res.json({ unsaved: await unsavedAt(base, req.query.path) });
    } catch (e) {
      fail(res, e);
    }
  });

  /** `discard=1` says that git work the folder holds, which nothing else has, may go with it. */
  router.delete("/sessions/:id/file", async (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    try {
      await removeEntry(base, req.query.path, req.query.discard === "1");
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
  router.get("/sessions/:id/archive", (req, res) => {
    const chat = folderOf(req.params.id, res);
    if (!chat) return;
    let base: string;
    try {
      base = folderPath(chat, req.query.path);
    } catch (e) {
      return fail(res, e);
    }
    const name = path.basename(base).replace(/[^a-zA-Z0-9_.-]/g, "_") || "workspace";
    const tar = spawn("tar", ["-czf", "-", ...ARCHIVE_EXCLUDES.map((d) => `--exclude=${d}`), "-C", base, "."]);
    // The download is not announced until tar has produced something: a tar that
    // cannot start, or dies at once, is then an error the person is told about,
    // not a file of zero bytes that the browser calls finished.
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
      console.error("[portal] archive: could not run tar:", e.message);
      answered = true;
      if (started) res.destroy();
      else res.status(500).json({ error: "Could not make the archive: tar is not available" });
    });
    tar.on("close", (code) => {
      // Already answered, or killed because nobody was waiting any more.
      if (answered || code === null || res.destroyed) return;
      answered = true;
      // 1 is "a file changed or vanished while it was read": what was read is in
      // the archive, and that is the ordinary way a busy folder ends. Anything
      // else means the archive is not the folder, so the download is cut off and
      // fails, rather than ending as if it were whole.
      if (code > 1) {
        console.error(`[portal] archive: tar exited ${code}: ${complaints.trim()}`);
        if (started) return void res.destroy();
        return void res.status(500).json({ error: "Could not make the archive" });
      }
      if (!started) begin();
      res.end();
    });
    // Nobody is waiting any more.
    res.on("close", () => tar.kill());
  });

  return router;
}
