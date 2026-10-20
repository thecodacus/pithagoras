import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { Page } from "@playwright/test";
import kanban from "../../src/server.ts";

/**
 * Kanban's own server half for a browser spec, in the spec's process: started with a stand-in for the portal (its
 * routes, a data folder of its own, the chats the spec names), and the page's requests to its routes passed on to it as
 * they are. So what the page shows is what the server half answers, and what an agent's tool does in the meantime is
 * done to the same boards. `asked` is every request the page made of it, with what it sent.
 */
export async function kanbanServer(chats: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kanban-browser-"));
  const router = express.Router();
  const factories: ((pi: unknown, chat: unknown) => void)[] = [];
  const chat = (id: string) => (id in chats ? { id, title: chats[id], workspace: "/workspaces/pithagoras", status: "idle" } : undefined);
  const stop = kanban({
    router,
    http: { json: express.json },
    dataDir: () => dir,
    log: () => {},
    tools: { offer: () => {} },
    chats: { get: chat, extend: (factory: (pi: unknown, chat: unknown) => void) => factories.push(factory), on: () => {} },
  } as never) as () => Promise<void>;
  const server = express().use("/api/x/pithagoras-kanban", router).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const asked: { method: string; path: string; body: any }[] = [];
  let closed = false;

  /** A request of the spec's own, as the page would make it: the JSON it answered. */
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api/x/pithagoras-kanban${route}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const got = await res.json();
    if (!res.ok) throw new Error(`${method} ${route}: ${got.error}`);
    return got;
  };

  return {
    asked,
    call,
    /** The page's requests to Kanban's routes go to this server half. */
    serve: (page: Page) =>
      page.route("**/api/x/pithagoras-kanban/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        asked.push({ method: request.method(), path: url.pathname.replace("/api/x/pithagoras-kanban", "") + url.search, body: request.postData() ? request.postDataJSON() : undefined });
        // A look the page makes as the test ends finds the server half stopped: it is let go, as a portal that went away.
        if (closed) return route.abort();
        try {
          await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
        } catch {
          await route.abort().catch(() => {});
        }
      }),
    /** The kanban tools a chat's agent has: what it does with them is the agent's, as in a chat. */
    tools: (id: string) => {
      const tools: Record<string, { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: any }> }> = {};
      for (const factory of factories) factory({ registerTool: (tool: any) => (tools[tool.name] = tool) }, chat(id));
      return tools;
    },
    /** What the page asked of the routes since, by method and path. */
    since: (n: number) => asked.slice(n).map((a) => `${a.method} ${a.path.split("?")[0]}`),
    close: async () => {
      closed = true;
      await stop();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A board as a team would have it: columns, and cards with labels, people, due days and notes. */
export async function realisticBoard(server: Awaited<ReturnType<typeof kanbanServer>>, name = "Release 0.2") {
  const board = await server.call("POST", "/boards", { name, columns: ["Backlog", "To do", "In progress", "Review", "Done"] });
  await server.call("PATCH", `/boards/${board.id}`, { description: "Everything that has to land before the 0.2 release goes out." });
  const [backlog, todo, doing, review, done] = board.columns.map((c: { id: string }) => c.id);
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const cards: [string, string, Record<string, unknown>][] = [
    [backlog, "Dark mode for the settings page", { labels: ["ui"], description: "The settings page still has a few hard-coded colours." }],
    [backlog, "Export a board as Markdown", { labels: ["idea"] }],
    [todo, "Write the upgrade notes", { labels: ["docs"], assignee: "Anirban", due: day(3) }],
    [todo, "Check the voice add-on on a 6 GB card", { labels: ["voice", "test"], assignee: "agent" }],
    [todo, "Rotate the signing key", { labels: ["security"], due: day(-2), description: "Expired last week; builds still pass with the old one." }],
    [doing, "Fix the flaky login test", { labels: ["bug", "test"], assignee: "agent", due: day(1), description: "Fails one run in five on CI." }],
    [doing, "Kanban extension", { labels: ["feature"], assignee: "Anirban" }],
    [review, "Faster prefill on llama.cpp", { labels: ["perf"], assignee: "agent" }],
    [done, "Media is an extension", { labels: ["feature"] }],
    [done, "Docker settings page", { labels: ["ui", "feature"] }],
  ];
  let latest = board;
  for (const [column, title, more] of cards) latest = await server.call("POST", `/boards/${board.id}/cards`, { column, title, ...more });
  const flaky = latest.cards.find((c: { title: string }) => c.title === "Fix the flaky login test");
  latest = await server.call("POST", `/boards/${board.id}/cards/${flaky.id}/notes`, { text: "Found it: the session cookie expires a second early." });
  return latest;
}
