import { closeSync, createReadStream, fstatSync } from "node:fs";
import type { Request, Response } from "express";
import { parseRange } from "./http-range.js";

// Its own module, beside api/files.ts which serves the portal's own files with it: a server half in a process of its own
// sends a file with it too (half-runtime.ts), and loads nothing of the portal's for it.

/**
 * Sends a clip that was opened by openVideo, as sendPicture sends a picture and under the same policy, and with
 * what a player needs: it asks for the part of the file it is about to show (`Range`), and is answered with just
 * that, so that a clip of tens of megabytes starts at once and can be moved around in. The descriptor is
 * closed with the response, or at once if the response is already gone. With `download` (a file name) the file is sent
 * to be saved and never shown: for a clip a browser does not play, and for any other file.
 */
export function sendFile(req: Request, res: Response, opened: { fd: number; size: number; mimeType: string }, cache: string, download?: string): void {
  const { fd, size, mimeType } = opened;
  if (res.destroyed) return void closeSync(fd);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (download !== undefined) res.setHeader("Content-Disposition", `attachment; filename="${download.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(download)}`);
  res.setHeader("Cache-Control", cache);
  res.setHeader("Accept-Ranges", "bytes");
  const modified = fstatSync(fd).mtime;
  const etag = `"${size.toString(16)}-${modified.getTime().toString(16)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", modified.toUTCString());
  if (req.fresh) {
    closeSync(fd);
    return void res.status(304).end();
  }
  // A range goes with the version of the file the player has: for another it is the whole of this one (If-Range).
  const ifRange = req.headers["if-range"] as string | undefined;
  const sameFile = !ifRange || ifRange === etag || Date.parse(ifRange) === Math.floor(modified.getTime() / 1000) * 1000;
  const range = sameFile ? parseRange(req.headers.range, size) : ({ kind: "all" } as const);
  if (range.kind === "unsatisfiable") {
    closeSync(fd);
    res.setHeader("Content-Range", `bytes */${size}`);
    return void res.status(416).end();
  }
  const [start, end] = range.kind === "range" ? [range.start, range.end] : [0, Math.max(0, size - 1)];
  res.setHeader("Content-Type", mimeType);
  if (range.kind === "range") {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("Content-Length", range.kind === "range" ? end - start + 1 : size);
  const stream = createReadStream("", { fd, start, end });
  stream.on("error", (e) => {
    console.error("[portal] files: video failed:", e.message);
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
