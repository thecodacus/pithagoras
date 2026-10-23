import { closeSync, createReadStream, createWriteStream, fstatSync } from "node:fs";
import express, { type Request, type Response, type Router } from "express";
import { getSession } from "../db.js";
import { unsavedRefusal } from "../git.js";
import { sendFile } from "../send-file.js";
import { openVideo } from "../video-files.js";
import { FileError, baseDir, uploadTarget, openDownload, openPicture } from "../workspace-files.js";

/**
 * What the portal itself serves of a chat's folder: a picture or a clip to be
 * drawn in the page (the conversation, a tool's call, Canvases), a
 * file a call gave the person to download, and a file put there from the
 * message box. Browsing and changing the folder is
 * an extension's (Files'), with the same checks through `portal.files`.
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
 * with the response, or at once if the response is already gone. `cache` is what the browser may keep it for.
 */
export function sendPicture(req: Request, res: Response, opened: ReturnType<typeof openPicture>, cache: string): void {
  const { fd, size, mimeType } = opened;
  // The person may have gone while the picture was being made ready: there is no close to come for the stream, so the file is let go here.
  if (res.destroyed) return void closeSync(fd);
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

  /**
   * A picture in the folder, drawn in the page rather than downloaded: for the
   * conversation, an extension that shows one (Files, a canvas), and what a
   * tool's call puts in front of the person. Only what its bytes say is a
   * picture is sent, with that type, and under a policy that would stop it
   * running anything even if a browser disagreed.
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

  /**
   * A clip in the folder, played in the page rather than downloaded: for what a tool's call puts in front of the
   * person. Only what its bytes say is a WebM or an MP4 is sent, with that type and under the same policy as a
   * picture, and in parts where the player asks.
   */
  router.get("/sessions/:id/video", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    let opened: ReturnType<typeof openVideo>;
    try {
      opened = openVideo(base, req.query.path);
    } catch (e) {
      return fail(res, e);
    }
    sendFile(req, res, opened, "private, no-cache");
  });

  /**
   * Any file in the folder, to be saved and never shown: for a file a call gave the person that is neither a picture
   * nor a clip (see file-outputs.ts), which the chat links to. Sent as bytes, whatever it is called.
   */
  router.get("/sessions/:id/file", (req, res) => {
    const base = folderOf(req.params.id, res);
    if (!base) return;
    let opened: ReturnType<typeof openDownload>;
    try {
      opened = openDownload(base, req.query.path);
    } catch (e) {
      return fail(res, e);
    }
    sendFile(req, res, { ...opened, mimeType: "application/octet-stream" }, "private, no-cache", opened.name);
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

  return router;
}
