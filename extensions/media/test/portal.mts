import { after } from "node:test";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

/**
 * Media as the portal runs it, in the process of a test: its server half started by the portal's own extension host,
 * which gives it the portal's real `portal` (the chats of the portal's database, the portal's file rules, the folders
 * the agents work in, its data folder, the hand-off an upgrade left), and its routes served as the portal serves an
 * extension's, under /api/x/pithagoras-media, beside the portal's own routes of a chat's files. Nothing of it is a
 * stand-in: what the tests do to it is what the portal does, a chat deleted or a folder removed included.
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load. A database the test put in
 * the home before is the one the portal opens, and upgrades, before the half starts, as the portal does.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));
const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

export async function startMedia() {
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  const { filesRouter } = await import(core("api/files.js"));
  const { name, version } = JSON.parse(readFileSync(PACKAGE, "utf8"));

  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();
  await host.syncServerHalves([{ name, version, file: SERVER, rev: version }]);
  const failed = host.serverFailure(name);
  if (failed) throw new Error(`Media's server half did not start: ${failed}`);

  const app = express()
    .use("/api/x", host.extensionRoutes)
    .use("/api", filesRouter())
    // What a route did not catch, or a body it could not read, in JSON with its message, as the portal's own handler says it.
    .use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(async () => {
    server.close();
    await host.stopServerHalves();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    /** Where Media's routes are, and the portal's own. */
    at: `${origin}/api/x/${name}`,
    api: `${origin}/api`,
    /** Media's own folder in the portal's data folder, as it is given it. */
    data: realpathSync(path.join(process.env.DATA_DIR!, "extension-data", name)),
    db,
    host,
    /** A chat of the portal's that works in `workspace`. */
    chat: (id: string, workspace: string, title = "A chat", kind?: "routine") => db.createSession({ id, title, workspace, executor: "host", ...(kind ? { kind } : {}) }),
    /** A chat deleted as the portal deletes one: its row goes, and then the server halves are told. */
    deleteChat: (id: string) => {
      db.deleteSession(id);
      host.chatLife("deleted", id);
    },
    /**
     * A folder the agents worked in that the portal deleted: the server halves are told where it really was. It is
     * gone by then, so that is where its parent really is, and its name.
     */
    folderRemoved: (folder: string) => host.folderRemoved(path.join(realpathSync(path.dirname(folder)), path.basename(folder))),
    /** The tools a chat's pi is given as it loads, by name, as the portal gives them. */
    tools: (chatId: string): Record<string, any> => {
      const tools: Record<string, any> = {};
      for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (tool: any) => (tools[tool.name] = tool) });
      return tools;
    },
  };
}
