import { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeDocker } from "../../docker/test/fake-docker.ts";

/**
 * Browser as the portal runs it, in the process of a test: its server half started by the portal's own extension
 * host, after Docker's, which it requires, each from its own package as the portal reads it, and Docker speaking to a
 * daemon of the tests' own (Docker's fake-docker.ts), never to one on the machine.
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;

/** A server half of a package in extensions/, from its source, with what its package.json says it requires. */
async function half(folder: string) {
  const { requiresOf } = await import(core("extension-ui.js"));
  const meta = JSON.parse(readFileSync(new URL(`../../${folder}/package.json`, import.meta.url), "utf8"));
  return { name: meta.name as string, version: meta.version as string, file: fileURLToPath(new URL(`../../${folder}/src/server.ts`, import.meta.url)), rev: meta.version as string, requires: requiresOf(meta) };
}

export async function startBrowser() {
  const docker = await fakeDocker();
  process.env.DOCKER_SOCKET = docker.socket;
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();
  const halves = { docker: await half("docker"), browser: await half("browser") };
  after(async () => {
    await host.stopServerHalves();
    await docker.close();
  });
  return {
    host,
    docker,
    /** The two server halves, to start with `host.syncServerHalves`. */
    halves,
  };
}
