import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DATA_DIR } from "./data-dir.js";
import { allowNoPassword, bindHost, tlsFiles } from "./http-security.js";
import { SCHEMA_VERSION, dbFile } from "./schema-version.js";

/**
 * Upgrading the database before the server starts, so that an upgrade is safe
 * and visible rather than a crash loop.
 *
 * A database below SCHEMA_VERSION is checked for damage and backed up before it
 * is changed, off the main thread, while a maintenance page answers on the
 * portal's own address. Damaged, or with no room for the backup, it is left as
 * it was and the page stays up saying why and what to do: a server that exited
 * would be restarted by Docker into the same failure, over and over, with the
 * reason only in its log. One above it was made by a newer portal, which may
 * have renamed or dropped what this one reads: it is not opened either.
 */

export interface UpgradeCheck {
  needed: boolean;
  /** The version the file is at; 0 before versions were kept. */
  from: number;
  /** The file was made by a newer portal than this one: it is not opened, whatever this one could read of it. */
  newer?: boolean;
}

/** Whether the database needs upgrading. A new install has nothing to keep and is not checked. */
export function upgradeCheck(file = dbFile()): UpgradeCheck {
  if (!existsSync(file)) return { needed: false, from: 0 };
  const d = new Database(file, { fileMustExist: true });
  try {
    const used = Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get());
    const from = d.pragma("user_version", { simple: true }) as number;
    if (used && from > SCHEMA_VERSION) return { needed: false, from, newer: true };
    return { needed: used && from < SCHEMA_VERSION, from };
  } finally {
    d.close();
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Quoted for a shell, so that a path with a space or a quote in it is still one word. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether the portal is in a container: it is told its container's name, or it is in one. */
const inContainer = (env: NodeJS.ProcessEnv) => Boolean(env.PORTAL_CONTAINER_NAME) || existsSync("/.dockerenv");

/**
 * How to repair a damaged database, shown on the page and in the log. In a
 * container, by the container's name (`PORTAL_CONTAINER_NAME`, which both
 * shipped Compose files set to `pithagoras`) and the volume it has at /data,
 * read from it: the Compose service and the volume are named differently in
 * each. Natively, on the data folder itself.
 */
export function repairSteps(env: NodeJS.ProcessEnv = process.env, dataDir = DATA_DIR, container = inContainer(env)): string[] {
  if (!container) {
    return [
      "Stop the portal.",
      `Recover what can be read into a new file:\nsqlite3 ${sh(path.join(dataDir, "portal.db"))} .recover | sqlite3 ${sh(path.join(dataDir, "portal-recovered.db"))}`,
      `Keep the damaged file and put the recovered one in its place:\ncd ${sh(dataDir)} && mv portal.db portal-damaged.db && rm -f portal.db-wal portal.db-shm && mv portal-recovered.db portal.db`,
      "Start the portal again. It checks the recovered database before upgrading it.",
    ];
  }
  // A container's name is of this shape; anything else is not put in a command to be pasted.
  const name = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(env.PORTAL_CONTAINER_NAME ?? "") ? env.PORTAL_CONTAINER_NAME! : "pithagoras";
  const volumeOf = `DATA=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' ${name})`;
  return [
    `Stop the portal (docker stop ${name}).`,
    `Find the volume that holds its data:\n${volumeOf}`,
    "Recover what can be read into a new file:\n" +
      'docker run --rm -v "$DATA:/data" alpine sh -c "apk add -q sqlite && sqlite3 /data/portal.db .recover | sqlite3 /data/portal-recovered.db"',
    "Keep the damaged file and put the recovered one in its place:\n" +
      'docker run --rm -v "$DATA:/data" alpine sh -c "cd /data && mv portal.db portal-damaged.db && rm -f portal.db-wal portal.db-shm && mv portal-recovered.db portal.db"',
    `Start the portal again (docker start ${name}). It checks the recovered database before upgrading it.`,
  ];
}

function page(state: { message: string; failed?: string; damaged?: boolean; title?: string }): string {
  const body = state.failed
    ? `<h1>${esc(state.title ?? "The database could not be upgraded")}</h1><p>${esc(state.failed)}</p><p>Nothing was changed: the portal is still on the database as it was.</p>` +
      (state.damaged ? `<h2>To repair it</h2><ol>${repairSteps().map((s) => `<li><pre>${esc(s)}</pre></li>`).join("")}</ol>` : "")
    : `<h1>Upgrading</h1><p>${esc(state.message)}</p><p>This page reloads by itself, and the portal opens when the upgrade is done.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pithagoras: upgrading</title>${state.failed ? "" : '<meta http-equiv="refresh" content="3">'}` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:15px/1.5 system-ui,sans-serif;background:#0b0b0d;color:#e8e8ec;max-width:46rem;margin:12vh auto;padding:0 1.25rem}` +
    `h1{font-size:1.3rem}h2{font-size:1rem;margin-top:2rem}pre{white-space:pre-wrap;background:#18181c;border:1px solid #2c2c32;border-radius:8px;padding:.6rem .8rem;font-size:.82rem}p{color:#a3a3ad}</style></head><body>${body}</body></html>`;
}

/**
 * The page, on the portal's port, host and certificate, until the upgrade is
 * done. API calls get a 503 with the same words, so a client knows to wait.
 */
function maintenance() {
  const state: { message: string; failed?: string; damaged?: boolean; title?: string } = { message: "Preparing." };
  const answer = (req: IncomingMessage, res: ServerResponse) => {
    const status = state.failed ? 500 : 503;
    if ((req.url ?? "").startsWith("/api/")) {
      res.writeHead(status, { "Content-Type": "application/json", "Retry-After": "5" });
      res.end(JSON.stringify({ error: state.failed ?? `Upgrading the database: ${state.message}`, upgrading: !state.failed }));
      return;
    }
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" });
    res.end(page(state));
  };
  const tlsAt = tlsFiles();
  const server = tlsAt ? createHttpsServer({ cert: readFileSync(tlsAt.cert), key: readFileSync(tlsAt.key) }, answer) : createHttpServer(answer);
  // The page is a courtesy: a port it cannot have is said, and the upgrade goes on without it.
  server.on("error", (e) => console.error(`[portal] the upgrade page could not be shown: ${e.message}`));
  // The database is not readable yet, so whether it holds a password is not known: open by choice is the only case that stays on this machine.
  server.listen(Number(process.env.PORT || 4100), bindHost(!allowNoPassword() || Boolean(process.env.PORTAL_PASSWORD), process.env.ALLOW_OPEN));
  return {
    say: (message: string) => { state.message = message; },
    fail: (error: string, damaged: boolean, title?: string) => { state.failed = error; state.damaged = damaged; state.title = title; },
    // Resolved whether or not it was listening, so the server proper can start either way.
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Holds the process up with the page showing, so it is not restarted into the same failure. */
const forever = () => new Promise<never>(() => {});

/**
 * Upgrades the database if it needs it; returns once the server may open it.
 * Where it cannot be upgraded, it does not return.
 */
export async function prepareDatabase(): Promise<void> {
  let check: UpgradeCheck;
  try {
    check = upgradeCheck();
  } catch (e) {
    const error = `The database could not be opened: ${(e as Error).message}`;
    console.error(`[portal] ${error}\n${repairSteps().map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
    maintenance().fail(error, true);
    return forever();
  }
  if (check.newer) {
    const error =
      `The database is at version ${check.from}, from a newer portal than this one, which understands up to ${SCHEMA_VERSION}. ` +
      "Start the newer portal again, or put back the backup from before it upgraded the database (see Going back in the upgrading guide).";
    console.error(`[portal] ${error}`);
    maintenance().fail(error, false, "The database is from a newer version");
    return forever();
  }
  if (!check.needed) return;

  console.log(`[portal] upgrading the database from version ${check.from} to ${SCHEMA_VERSION}`);
  const view = maintenance();
  const outcome = await new Promise<{ backup?: string } | { error: string; damaged: boolean }>((resolve) => {
    const worker = new Worker(new URL("./db-upgrade-worker.js", import.meta.url), {
      // Not the server's own flags: some, such as --input-type, are refused in a worker and would fail the upgrade.
      execArgv: [],
      workerData: { file: dbFile(), from: check.from, backupDir: path.join(DATA_DIR, "backups"), skipBackup: process.env.PORTAL_UPGRADE_BACKUP === "skip" },
    });
    let settled = false;
    let said = "";
    // Ended once it has answered: what it loaded to migrate would otherwise keep it, and the process, running.
    const end = (result: { backup?: string } | { error: string; damaged: boolean }) => { settled = true; void worker.terminate(); resolve(result); };
    worker.on("message", (m: { type: string; message?: string; backup?: string; error?: string; damaged?: boolean }) => {
      // Logged when it says something new: the backup reports progress far more often than its percentage moves.
      if (m.type === "progress" && m.message !== said) { said = m.message!; view.say(said); console.log(`[portal] ${said}`); }
      if (m.type === "done") end({ backup: m.backup });
      if (m.type === "failed") end({ error: m.error!, damaged: Boolean(m.damaged) });
    });
    worker.on("error", (e) => { if (!settled) { settled = true; resolve({ error: e.message, damaged: false }); } });
    worker.on("exit", (code) => { if (!settled) resolve({ error: `The upgrade stopped unexpectedly (exit ${code})`, damaged: false }); });
  });
  if ("error" in outcome) {
    console.error(`[portal] the database was not upgraded: ${outcome.error}`);
    if (outcome.damaged) console.error(repairSteps().map((s, i) => `  ${i + 1}. ${s}`).join("\n"));
    view.fail(outcome.error, outcome.damaged);
    return forever();
  }
  console.log(`[portal] database upgraded${outcome.backup ? `; the copy from before is ${outcome.backup}` : ""}`);
  await view.close();
}
