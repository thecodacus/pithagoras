import type { Request, Response } from "express";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { pathBelow } from "./within.js";
import { accepted } from "./web-static.js";

/**
 * Sends a text file of an extension's web folder compressed, for the browser that takes it.
 *
 * The files are not built the way the portal's own web app is, with a `.br` copy beside each, so they
 * are compressed here, once for as long as the file stays as it is. A module of several hundred
 * kilobytes is a fifth of that on the wire, and every level of its imports is a request of its own.
 */

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

/** What compresses well. A picture or a font is already compressed. */
const TEXT = new Set([".js", ".mjs", ".css", ".json", ".svg", ".html", ".txt", ".map"]);
/** Below this a response is not worth the time it takes to compress, or the header it carries. */
const SMALL = 1024;
/** Above this a file is streamed as it is: it would be read whole and compressed before its first byte, for a file that is no module. */
const LARGE = 8 * 1024 * 1024;
/** What is kept compressed, in bytes: the oldest go first. A portal has a handful of extensions, and a few megabytes of each. */
const KEPT = 64 * 1024 * 1024;

type Made = { stamp: string; body: Promise<Buffer> };
const made = new Map<string, Made>();
let held = 0;
const sizes = new WeakMap<Promise<Buffer>, number>();

function forget(key: string) {
  const old = made.get(key);
  if (!old) return;
  made.delete(key);
  held -= sizes.get(old.body) ?? 0;
}

function compressed(key: string, stamp: string, file: string, encoding: "br" | "gzip"): Promise<Buffer> {
  const have = made.get(key);
  if (have?.stamp === stamp) return have.body;
  forget(key);
  const body = readFile(file).then((bytes) =>
    encoding === "br"
      ? brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })
      : deflate(bytes, { level: 6 }),
  );
  made.set(key, { stamp, body });
  body.then(
    (done) => {
      // Only counted while it is still what is kept: a file changed meanwhile has replaced it.
      if (made.get(key)?.body !== body) return;
      // One that is a large part of what is kept is sent, and not kept: it would send the rest of them out.
      if (done.length > KEPT / 16) return forget(key);
      sizes.set(body, done.length);
      held += done.length;
      while (held > KEPT) {
        const oldest = made.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        forget(oldest);
      }
    },
    () => forget(key),
  );
  return body;
}

/**
 * Whether it sent `rel` of the folder `root`: it did not, and the caller goes on to send the file as it is,
 * for a request that takes no encoding, a file that is no text or too small, a name that is not a plain file
 * inside the folder (the caller refuses it), or one that could not be read.
 */
export async function sendCompressed(req: Request, res: Response, root: string, rel: string): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!TEXT.has(path.extname(rel).toLowerCase())) return false;
  // Hidden files are the caller's to refuse, as the folder's way out is.
  if (rel.split("/").some((part) => part.startsWith("."))) return false;
  const file = path.resolve(root, rel);
  if (pathBelow(root, file) === undefined) return false;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size < SMALL || stat.size > LARGE) return false;
  // The same address answers differently by what the browser takes: a cache in between has to know.
  res.setHeader("Vary", "Accept-Encoding");
  const wanted = accepted(req.headers["accept-encoding"]);
  const encoding = wanted.has("br") ? "br" : wanted.has("gzip") ? "gzip" : undefined;
  if (!encoding) return false;
  const stamp = `${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}`;
  try {
    const body = await compressed(`${file}\0${encoding}`, stamp, file, encoding);
    res.type(path.extname(file));
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    // Of what is sent, so that a copy in one encoding is not taken for the other's. A browser that already
    // has it is told so by `send`, which compares this with what the request holds.
    res.setHeader("ETag", `"${stamp}-${encoding}"`);
    res.send(body);
    return true;
  } catch {
    res.removeHeader("Content-Encoding");
    return false;
  }
}
