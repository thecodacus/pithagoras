import type { RequestHandler, Request, Router } from "express";
import { UNDERSTORY, understoryTokenOf } from "./entry";
import { portal } from "./host";
import { statusOf } from "./routes";
import * as service from "./service";

/**
 * The agent's memory, to look through: Understory's own read API, handed on.
 *
 * Understory's web UI reads a small JSON API at its root — the tree of the
 * bundle, one concept, a search, the log of changes, the graph of links, the
 * paths its queries took, whether the bundle is well-formed. Asked from here
 * (/api/x/pithagoras-understory/…) rather than from the page: the address in
 * mcp.json is where the portal reaches it, which the browser may not
 * (localhost, a Docker network, plain HTTP behind an HTTPS portal), and the
 * token stays on the server. Only these reads are
 * handed on; the few changes below go through Understory's own write path in
 * the container the portal runs, never through its HTTP API, which has none.
 * The one thing beyond the reads is the librarian chat, handed on in the same
 * way: Understory's agent answers there, and writes through its own tools.
 *
 * It is not a documented API, so a failure says what Understory answered
 * rather than pretending the memory is empty.
 */
const READS = {
  tree: { path: "/api/tree", params: [] },
  concept: { path: "/api/concept", params: ["path"] },
  search: { path: "/api/search", params: ["q"] },
  log: { path: "/api/log", params: [] },
  graph: { path: "/api/graph", params: [] },
  traces: { path: "/api/traces", params: [] },
  /** One run with its steps: what the list leaves out, and the full paths of the notes each step touched. */
  trace: { path: "/api/trace", params: ["id"] },
  validate: { path: "/api/validate", params: [] },
} as const;

/**
 * Where Understory answers, and with what token, while it is the agent's memory: its server in mcp.json, not switched
 * off there, whether or not pi-mcp-adapter is on to give the chats its tools.
 */
function understoryAt(): { origin: string; token?: string } | undefined {
  const entry = portal().mcp.get(UNDERSTORY)?.entry;
  if (!entry || entry.disabled === true) return undefined;
  try {
    return typeof entry.url === "string" ? { origin: new URL(entry.url).origin, token: understoryTokenOf(entry) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the memory can be changed here: it is the Understory the portal
 * runs, whose container the portal can run Understory's own write path in.
 * One run elsewhere is read, not written.
 */
async function writable(): Promise<boolean> {
  const at = understoryAt();
  if (!at || at.origin !== new URL(service.managedUrl()).origin) return false;
  return (await service.status()).container === "running";
}

/** A note's path as Understory takes one: absolute, markdown, and not its own index or log. */
export function notePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\/[^\0]*\.md$/.test(value) || value.split("/").includes("..")) return undefined;
  const name = value.split("/").pop();
  return name === "index.md" || name === "log.md" ? undefined : value;
}

/** The most messages of a conversation passed on: the page keeps its history under this (HISTORY_MESSAGES in memory-chat.ts), this is a ceiling. */
const MAX_CHAT_MESSAGES = 200;

/**
 * A conversation as Understory's chat takes it (the AI SDK's UI messages), cut
 * down to what it reads: an id, a role and parts, ending with the user's turn.
 */
export function chatMessages(value: unknown): { id: string; role: "user" | "assistant"; parts: unknown[] }[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHAT_MESSAGES) return undefined;
  const messages: { id: string; role: "user" | "assistant"; parts: unknown[] }[] = [];
  for (const m of value) {
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.parts)) return undefined;
    messages.push({ id: typeof m.id === "string" ? m.id : `m${messages.length}`, role: m.role, parts: m.parts });
  }
  return messages.at(-1)!.role === "user" ? messages : undefined;
}

/**
 * The Memory page's routes, beside the Settings page's (routes.ts). A route that takes JSON reads it, up to 2 MB: a
 * conversation with the librarian, or a note of about 95 kB once it is escaped.
 */
export function memoryRoutes(router: Router): void {
  const json = portal().http.json({ limit: "2mb" });
  // Whether Understory's librarian is in the middle of a turn that this portal started. See the chat route.
  let librarianRunning = false;

  /** Whether notes can be changed here, and what the bundle's links look like. */
  router.get("/health", async (_req, res) => {
    try {
      if (!(await writable())) return res.json({ writable: false });
      // Writable whatever the checks say, or whether they answered at all.
      res.json({ writable: true, health: await service.noteHealth().catch(() => undefined) });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  const changing =
    (fn: (req: Request) => Promise<unknown>): RequestHandler =>
    async (req, res) => {
      if (!(await writable().catch(() => false))) {
        return res.status(409).json({ error: "Notes can be changed here only in the Understory the portal runs, while it is running and the agent's memory." });
      }
      try {
        res.json(await fn(req));
      } catch (e) {
        res.status(statusOf(e, 502)).json({ error: (e as Error).message });
      }
    };
  const refuse = (message: string) => Object.assign(new Error(message), { status: 400 });

  /** A note written by hand: its text and what its frontmatter says. Understory keeps the index and log. */
  router.put(
    "/concept",
    json,
    changing(async (req) => {
      const path = notePath(req.body?.path);
      if (!path) throw refuse("A note's path is absolute, ends in .md, and is not an index.md or log.md");
      const fm = req.body?.frontmatter;
      if (!fm || typeof fm !== "object" || Array.isArray(fm)) throw refuse("frontmatter must be an object");
      if (typeof fm.type !== "string" || !fm.type.trim() || typeof fm.title !== "string" || !fm.title.trim()) throw refuse("A note needs a type and a title");
      const body = req.body?.body;
      if (typeof body !== "string") throw refuse("body must be text");
      // As it will travel: its words, what it says of itself, and the line for the log.
      if (!service.fitsInEnv({ path, frontmatter: fm, body, summary: `Edited [${fm.title}](${path}) by hand in the portal.` })) {
        throw refuse("This note is too long to write from here: at most about 95 kB, less in scripts that take more bytes a letter");
      }
      return service.saveNote(path, fm, body);
    }),
  );

  router.delete(
    "/concept",
    changing(async (req) => {
      const path = notePath(req.query.path);
      if (!path) throw refuse("A note's path is absolute, ends in .md, and is not an index.md or log.md");
      return service.deleteNote(path);
    }),
  );

  /** Every index.md written anew and empty folders removed; no model involved. */
  router.post("/reindex", changing(() => service.reindex()));

  /** The model mends links to nothing and wires in orphans — only when there are any. */
  router.post("/repair", changing(() => service.repair()));

  /** The log of changes and the paths of Understory's queries started over; the notes stay. */
  router.post("/clear-log", changing(() => service.clearLog()));

  /** Everything gone: an empty index and log, as a new memory has. */
  router.post("/wipe", changing(() => service.wipe()));

  /**
   * The librarian: Understory's own agent, which Understory's web UI chats with.
   * It reads and writes the memory with its own tools, so — like a note edited
   * by hand — it is offered only in the Understory the portal runs. The page
   * keeps the conversation and sends it whole each time; the answer is
   * Understory's stream of UI message chunks, passed on as it comes.
   */
  router.post("/chat", json, async (req, res) => {
    if (!(await writable().catch(() => false))) {
      return res.status(409).json({ error: "The librarian can be asked only in the Understory the portal runs, while it is running and the agent's memory." });
    }
    const at = understoryAt();
    if (!at) return res.status(409).json({ error: "Understory is not the agent's memory." });
    if (Array.isArray(req.body?.messages) && req.body.messages.length > MAX_CHAT_MESSAGES) {
      return res.status(400).json({ error: "This conversation is too long to send: clear the chat and ask again." });
    }
    const messages = chatMessages(req.body?.messages);
    if (!messages) return res.status(400).json({ error: "messages must be a conversation: user and assistant messages with parts, ending in the user's" });
    // Understory's chat does not end its run when the connection drops: the librarian goes on with its steps, writes included.
    // So a second question waits until the first has really ended, rather than two librarians working on one memory.
    if (librarianRunning) return res.status(409).json({ error: "The librarian is still working on the previous question. Try again in a moment." });
    librarianRunning = true;
    // Whether the page is still listening. Its leaving (Stop, Clear chat, a closed tab) does not cut the stream to Understory:
    // that would not stop the run, only hide when it ends. The rest of the answer is read and dropped.
    let listening = true;
    res.on("close", () => (listening = false));
    try {
      const answer = await fetch(`${at.origin}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(at.token ? { authorization: `Bearer ${at.token}` } : {}) },
        body: JSON.stringify({ messages }),
      });
      if (!answer.ok || !answer.body) {
        const text = await answer.text().catch(() => "");
        let said = `status ${answer.status}`;
        try {
          const body = JSON.parse(text);
          if (body && typeof body.error === "string") said = body.error;
        } catch {}
        if (listening) res.status(502).json({ error: `Understory did not take the question: ${said}.` });
        return;
      }
      if (listening) {
        res.status(200);
        res.setHeader("content-type", answer.headers.get("content-type") ?? "text/event-stream");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders();
      }
      for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) if (listening) res.write(chunk);
      if (listening) res.end();
    } catch (e) {
      if (!listening) return;
      if (res.headersSent) {
        // The answer is cut off: say so in the stream's own way, or the page would show half a sentence as a whole one.
        // The empty line first ends an event that was cut in the middle.
        const why = `Understory stopped answering: ${(e as Error).message}.`;
        res.write(`\n\ndata: ${JSON.stringify({ type: "error", errorText: why })}\n\n`);
        return res.end();
      }
      res.status(502).json({ error: `Could not reach Understory at ${at.origin}: ${(e as Error).message}.` });
    } finally {
      librarianRunning = false;
    }
  });

  for (const [name, read] of Object.entries(READS)) {
    router.get(`/${name}`, async (req, res) => {
      const at = understoryAt();
      if (!at) return res.status(409).json({ error: "Understory is not the agent's memory. Switch it on in Settings → Memory." });
      const query = new URLSearchParams();
      for (const key of read.params) {
        const value = req.query[key];
        if (typeof value !== "string" || !value.trim()) return res.status(400).json({ error: `${key} is required` });
        query.set(key, value.slice(0, 500));
      }
      const { origin, token } = at;
      try {
        const answer = await fetch(`${origin}${read.path}${read.params.length ? `?${query}` : ""}`, {
          headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          signal: AbortSignal.timeout(10_000),
        });
        const text = await answer.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return res.status(502).json({ error: `Understory answered ${answer.status} with something that is not JSON.` });
        }
        if (!answer.ok) {
          const said = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `status ${answer.status}`;
          // Its own 404 — a concept that is not there — is the page's to say; anything else is Understory failing.
          return res.status(answer.status === 404 ? 404 : 502).json({ error: said });
        }
        res.json(body);
      } catch (e) {
        const reason = (e as Error).name === "TimeoutError" ? "it did not answer in time" : (e as Error).message;
        res.status(502).json({ error: `Could not reach Understory at ${origin}: ${reason}.` });
      }
    });
  }
}
