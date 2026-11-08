import { spawn } from "node:child_process";
import { closeSync, createReadStream } from "node:fs";
import path from "node:path";
import type { Request, RequestHandler, Response, Router } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { answerWithin, SourceRegistry, type FilesSource, type SourceContext, type SourceEntry } from "./sources";

/**
 * Files' server half: its routes at /api/x/pithagoras-files/chats/<chat>/…,
 * for listing, reading, downloading, saving, renaming and deleting what is in
 * the chat's folder, a new folder in it, and the whole of it as a .tar.gz.
 *
 * What may be reached and how it is read and written is the portal's
 * (`portal.files`): the agent writes in that folder, links included, and these
 * routes run in the portal's own process. This only turns a chat into its
 * folder, a request into a call, and a refusal into a status. Uploads and
 * pictures are the portal's own routes, which its message box and its
 * conversation use as well.
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

/** How long a source has to answer a call before the page is told it did not. */
const SOURCE_MS = 30_000;
/** What a source's list is cut to, as a folder's is. */
const LISTED = 2000;
/** The most of a source's file that is shown as text, as for the chat's folder; a larger one is offered as a download. */
const SHOWN_BYTES = 1024 * 1024;

export default function files(portal: ServerPortal) {
  const registry = new SourceRegistry();
  // What a source is given of who asks: never the chat's folder.
  const who = (req: Request, chatId: string): SourceContext => ({ chatId, owner: portal.chats.owner(chatId), person: portal.http.person(req) });
  // What an extension that builds on Files is given: the way to show its own file tree beside the chat's folder (src/sources.ts).
  portal.provide((consumer) => registry.forConsumer(consumer.name));
  routes(portal.router, portal.http.json(), portal.files, (id) => portal.chats.folder(id), { registry, who });
}

/** What serves the registered sources: who they are asked for (see SourceContext), and how long they have to answer. */
export interface SourceHost {
  registry: SourceRegistry;
  who(req: Request, chatId: string): SourceContext;
  timeoutMs?: number;
}

/** The routes, on `router` (the package's): `json` reads a body, `folderOf` is a chat's folder or throws. */
export function routes(router: Router, json: RequestHandler, files: Files, folderOf: (id: string) => string, sources?: SourceHost) {
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
      if (req.query.download !== "1") {
        // A page that only wants to know whether the file is still as it read it (`since` is its time, `size` its size) is told from a look at the
        // file, without reading it, and not sent the text again.
        if (req.query.since !== undefined) {
          const seen = files.open(at, pathOf(req));
          closeSync(seen.fd);
          if (Number(req.query.since) === seen.mtime && Number(req.query.size) === seen.size) return void res.json({ unchanged: true });
        }
        const read = files.read(at, pathOf(req));
        return void res.json(read);
      }
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
    let dir: string;
    try {
      dir = files.folder(at, pathOf(req));
    } catch (e) {
      return fail(res, e);
    }
    const name = path.basename(dir).replace(/[^a-zA-Z0-9_.-]/g, "_") || "workspace";
    const tar = spawn("tar", ["-czf", "-", ...ARCHIVE_EXCLUDES.map((d) => `--exclude=${d}`), "-C", dir, "."]);
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
  if (sources) sourceRoutes(router, json, folderOf, sources);

}

/** A refusal a source gave, by its code, or why the source failed; the page shows the words. */
function failSource(res: Response, source: FilesSource, e: unknown) {
  const code = (e as { code?: unknown })?.code;
  const message = e instanceof Error && e.message ? e.message : "";
  if (code === "timeout") return res.status(504).json({ error: message || `${source.label} did not answer in time`, code });
  // A source that refuses as the chat's folder does is told apart the same way (a save over a file that changed is a "conflict").
  if (typeof code === "string" && code in STATUS) return res.status(STATUS[code]).json({ error: message || "Refused", code });
  console.error(`[files] source ${source.id}:`, e);
  res.status(502).json({ error: message ? `${source.label}: ${message}` : `${source.label} could not be reached`, code: "source" });
}

/** A path in a source's own tree: text without a NUL, as the page has it. Nothing else is made of it, so it can never be read against the chat's folder. */
const sourcePath = (req: Request): string | undefined => {
  const given = req.query.path ?? "";
  return typeof given === "string" && given.length <= 4096 && !given.includes("\0") ? given : undefined;
};

/** What a source listed, as the page lists a folder: well-formed entries only, folders first. */
function listed(entries: unknown): { entries: { name: string; type: "file" | "dir"; size: number; mtime: number }[]; truncated: boolean } {
  const out = (Array.isArray(entries) ? (entries as SourceEntry[]) : [])
    .filter((e) => e && typeof e.name === "string" && e.name && !e.name.includes("/") && !e.name.includes("\0") && (e.type === "file" || e.type === "dir"))
    .map((e) => ({ name: e.name, type: e.type, size: e.type === "file" && Number.isFinite(e.size) ? Number(e.size) : 0, mtime: Number.isFinite(e.mtime) ? Number(e.mtime) : 0 }));
  out.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
  return { entries: out.slice(0, LISTED), truncated: out.length > LISTED };
}

/** A source's file as the page reads one: its text, or that it has none to show. */
function shown(file: unknown): { binary: true; size: number; mtime: number } | { binary: false; size: number; mtime: number; content: string } {
  const f = (file ?? {}) as { content?: unknown; bytes?: unknown; mtime?: unknown };
  const mtime = Number.isFinite(f.mtime) ? Number(f.mtime) : 0;
  if (typeof f.content === "string") {
    const size = Buffer.byteLength(f.content);
    return size > SHOWN_BYTES ? { binary: true, size, mtime } : { binary: false, size, mtime, content: f.content };
  }
  if (f.bytes instanceof Uint8Array) return { binary: true, size: f.bytes.byteLength, mtime };
  throw new Error("It gave neither text nor bytes for the file");
}

/**
 * The sources, at /chats/<chat>/sources: which there are for this chat, and for one of them its folders, its files, a download and a
 * save. The chat is looked up as for the chat's folder, so a chat that is gone has none; the folder itself is never read here.
 */
function sourceRoutes(router: Router, json: RequestHandler, folderOf: (id: string) => string, host: SourceHost) {
  const { registry } = host;
  const ms = host.timeoutMs ?? SOURCE_MS;
  /** The chat it is asked for, or the answer that there is none. */
  const chat = (req: Request, res: Response): SourceContext | undefined => {
    try {
      folderOf(String(req.params.id));
      return host.who(req, String(req.params.id));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message || "Not found" });
      return undefined;
    }
  };
  /** The chat, the source and the path, or the answer that one of them is not there. */
  const target = async (req: Request, res: Response): Promise<{ context: SourceContext; source: FilesSource; at: string } | undefined> => {
    const context = chat(req, res);
    if (!context) return undefined;
    const source = await registry.get(String(req.params.source), context);
    if (!source) return void res.status(404).json({ error: "There is no such source", code: "missing" });
    const at = sourcePath(req);
    if (at === undefined) return void res.status(400).json({ error: "That is not a path", code: "invalid" });
    return { context, source, at };
  };
  const ask = <T>(source: FilesSource, work: () => T | Promise<T>) => answerWithin(ms, work, source.label);

  router.get("/chats/:id/sources", async (req, res) => {
    const context = chat(req, res);
    if (!context) return;
    try {
      const all = await registry.list(context);
      res.json({ sources: all.map((s) => ({ id: s.id, label: s.label, writable: typeof s.write === "function" })) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/chats/:id/sources/:source/files", async (req, res) => {
    const found = await target(req, res);
    if (!found) return;
    try {
      res.json({ path: found.at, ...listed(await ask(found.source, () => found.source.list(found.at, found.context))) });
    } catch (e) {
      failSource(res, found.source, e);
    }
  });

  router.get("/chats/:id/sources/:source/file", async (req, res) => {
    const found = await target(req, res);
    if (!found) return;
    const { source, at, context } = found;
    try {
      if (req.query.download === "1") {
        const link = source.url ? await ask(source, () => source.url!(at, context)) : undefined;
        if (link !== undefined) {
          // Only a web address: what an extension gives is not trusted to be one.
          if (typeof link !== "string" || !/^https?:\/\//i.test(link)) throw new Error("It gave an address that is not http or https");
          return void res.redirect(302, link);
        }
        const file = (await ask(source, () => source.read(at, context))) as { content?: unknown; bytes?: unknown };
        const bytes = typeof file?.content === "string" ? Buffer.from(file.content) : file?.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : undefined;
        if (!bytes) throw new Error("It gave neither text nor bytes for the file");
        res.attachment(path.posix.basename(at) || source.id);
        return void res.send(bytes);
      }
      const read = shown(await ask(source, () => source.read(at, context)));
      // A page that only wants to know whether the file is still as it read it (`since` is its time, `size` its size).
      if (req.query.since !== undefined && Number(req.query.since) === read.mtime && Number(req.query.size) === read.size) return void res.json({ unchanged: true });
      res.json(read);
    } catch (e) {
      failSource(res, source, e);
    }
  });

  router.put("/chats/:id/sources/:source/file", json, async (req, res) => {
    const found = await target(req, res);
    if (!found) return;
    const { source, at, context } = found;
    const write = source.write;
    if (!write) return void res.status(405).json({ error: "This source is read-only", code: "read-only" });
    const { content, mtime } = req.body ?? {};
    if (typeof content !== "string") return void res.status(400).json({ error: "content is required" });
    if (mtime !== undefined && typeof mtime !== "number") return void res.status(400).json({ error: "mtime must be a number" });
    if (Buffer.byteLength(content) > SHOWN_BYTES) return void res.status(413).json({ error: "That is more than can be saved here", code: "too_large" });
    try {
      const done = await ask(source, () => write.call(source, at, content, { ...context, ...(typeof mtime === "number" && mtime > 0 ? { expected: mtime } : {}) }));
      const saved = Number.isFinite(done?.mtime) ? Number(done!.mtime) : 0;
      res.json({ ok: true, size: Buffer.byteLength(content), mtime: saved });
    } catch (e) {
      failSource(res, source, e);
    }
  });
}
