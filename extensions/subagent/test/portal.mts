import { after } from "node:test";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { scratch } from "../../../tests/helpers.mts";

/**
 * The subagent extension as the portal runs it, in the process of a test: installed the way the portal's extensions
 * are, as a package in pi's settings (`packages`) that pi lists, so that the portal's own extension host picks its
 * server half from the package's `pithagoras` block, switches it with Settings → Extensions' route, and serves its
 * routes as it serves them, beside the portal's old address for its settings (`/api/features/…`, core's).
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load. What pi's settings hold then
 * is what the portal's database upgrade finds as it is first opened here.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;

/** How pi's settings list the extension: where the portal's own folder is, as an install of it from there writes it. */
export const SPEC = "../../extensions/subagent";

export async function serveSubagent() {
  // No login to ask for: the portal checks it before an extension's routes are reached (auth tests).
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  const { extensionsRouter, syncExtensionServers } = await import(core("api/extensions.js"));
  const { featuresRouter } = await import(core("api/features.js"));
  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();

  // The package as pi lists it: its package.json as it is in the repository, so that what it declares is what is read,
  // and a server half of the file the test loads from source, as the built one is not there before the build.
  const folder = realpathSync(scratch("subagent-package-"));
  copyFileSync(new URL("../package.json", import.meta.url), path.join(folder, "package.json"));
  writeFileSync(path.join(folder, "server.js"), `export { default } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};\n`);
  const bin = path.join(folder, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "pi"), `#!/bin/bash\n[ "$1" = list ] || exit 0\nprintf 'User packages:\\n  %s\\n    %s\\n' ${JSON.stringify(SPEC)} ${JSON.stringify(folder)}\n`);
  chmodSync(path.join(bin, "pi"), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const piSettings = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
  const piFile = (): Record<string, any> => (existsSync(piSettings) ? JSON.parse(readFileSync(piSettings, "utf8")) : {});
  /** pi's settings with the extension listed as `entry` (a switched-off object, say), and the portal's server halves brought in line. */
  const install = async (entry: unknown = SPEC) => {
    mkdirSync(path.dirname(piSettings), { recursive: true });
    writeFileSync(piSettings, JSON.stringify({ ...piFile(), packages: [entry] }));
    await syncExtensionServers();
  };
  // A portal whose pi's settings list nothing has it installed; one that lists it already (an upgraded one) has it as listed.
  if ((piFile().packages ?? []).length === 0) await install();
  else await syncExtensionServers();
  after(() => host.stopServerHalves());
  const failed = host.serverFailure("pithagoras-subagent");
  if (failed) throw new Error(`The subagent extension's server half did not start: ${failed}`);

  const app = express()
    .use("/api/x", host.extensionRoutes)
    .use("/api", express.json(), featuresRouter(), extensionsRouter())
    // What a route did not catch, in JSON with its message, as the portal's own handler says it.
    .use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Settings → Extensions' switch for it. */
  const switchTo = async (enabled: boolean) => {
    const res = await fetch(`${base}/api/extensions/enabled`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: SPEC, enabled }) });
    if (!res.ok) throw new Error(`the switch answered ${res.status}: ${await res.text()}`);
  };

  /** What the half registers in a chat's pi as it is loaded, over a stand-in for pi: the tools, by their names. */
  const toolsIn = (chatId: string) => {
    const tools = new Map<string, any>();
    const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {}, events: { on: () => () => {}, emit: () => {} }, sendMessage: () => {} };
    for (const { name, factory } of host.hostExtensions(chatId)) if (name === "pithagoras-subagent") factory(pi);
    return tools;
  };
  return {
    host,
    db,
    /** Where the extension's routes are. */
    at: `${base}/api/x/pithagoras-subagent`,
    /** Where the portal's own are. */
    api: `${base}/api`,
    /** Its own folder in the portal's data folder, as it is given it. */
    get data() {
      return realpathSync(path.join(process.env.DATA_DIR!, "extension-data", "pithagoras-subagent"));
    },
    toolsIn,
    /** Switched off, as Settings → Extensions does, and on again: its server half stops and starts. */
    stop: () => switchTo(false),
    start: () => switchTo(true),
    /** Listed in pi's settings as `entry` says (a switched-off object, say), and the portal's server halves brought in line. */
    install,
    /** Where the portal's own are, with the extensions' list. */
    list: async () => (await (await fetch(`${base}/api/extensions`)).json()).extensions as { spec: string; name: string; enabled?: boolean; kinds: string[] }[],
  };
}
