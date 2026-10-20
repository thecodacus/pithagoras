import { after } from "node:test";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

/**
 * Kanban as the portal runs it, in the process of a test: its server half started by the portal's own extension host,
 * which gives it the portal's real `portal` (the chats of the portal's database, its data folder, the tools a chat's pi
 * is given), and its routes served as the portal serves an extension's, under /api/x/pithagoras-kanban.
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));
const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

export async function startKanban() {
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  const { name, version } = JSON.parse(readFileSync(PACKAGE, "utf8"));

  db.getDb();
  await host.syncServerHalves([{ name, version, file: SERVER, rev: version }]);
  const failed = host.serverFailure(name);
  if (failed) throw new Error(`Kanban's server half did not start: ${failed}`);

  const app = express()
    .use("/api/x", host.extensionRoutes)
    // A body that could not be read, in JSON with its message, as the portal's own handler says it.
    .use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(async () => {
    server.close();
    await host.stopServerHalves();
  });
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x/${name}`;

  return {
    at,
    /** A request to Kanban's routes: its status, and the JSON it answered. */
    ask: async (method: string, route: string, body?: unknown) => {
      const res = await fetch(`${at}${route}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    },
    /** Kanban's own folder in the portal's data folder, as it is given it. */
    data: realpathSync(path.join(process.env.DATA_DIR!, "extension-data", name)),
    host,
    /** A chat of the portal's. */
    chat: (id: string, title: string) => db.createSession({ id, title, workspace: process.env.WORKSPACE_ROOT!, executor: "host" }),
    rename: (id: string, title: string) => db.updateSession(id, { title }),
    /** A chat deleted as the portal deletes one: its row goes, and then the server halves are told. */
    deleteChat: (id: string) => {
      db.deleteSession(id);
      host.chatLife("deleted", id);
    },
    /** The tools a chat's pi is given as it loads, by name, as the portal gives them. */
    tools: (chatId: string): Record<string, any> => {
      const tools: Record<string, any> = {};
      for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (tool: any) => (tools[tool.name] = tool) });
      return tools;
    },
    /** What Settings → Tools is told the package offers. */
    offered: (): { name: string; description: string }[] => host.offeredTools().get(name) ?? [],
  };
}
