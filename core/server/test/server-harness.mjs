import { after } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The whole server, started as it is deployed, for the tests that need it:
 * each in a home of its own, stopped and removed when the file's tests end.
 */
export const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const started = [];
const homes = [];
// On the root of whichever test file imports this.
after(async () => {
  await Promise.all(started.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await once(child, "exit");
  }));
});
// The homes go when the process ends, not in a hook: a test that loads the server's modules
// closes its database in a hook of its own, which may run after any hook here.
process.on("exit", () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A new folder in the system's temp directory, removed when the process ends: for what a test needs to put things in. */
export function scratch(prefix) {
  const folder = mkdtempSync(path.join(tmpdir(), prefix));
  homes.push(folder);
  return folder;
}

/** A new home: the server's data, sessions and pi's agent directory, all in one place. */
export function testHome(prefix) {
  const home = scratch(prefix);
  mkdirSync(path.join(home, "agent"), { recursive: true });
  mkdirSync(path.join(home, "agent-home"), { recursive: true });
  return home;
}

export const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * Every folder the server reads and writes, set to a place in `home`: none of them is left to its default.
 * And git is kept from looking above the temp folder for a repository: where that folder lies inside one, a
 * command pi runs in a chat folder would otherwise be run in it, with the developer's credentials. Nor does it
 * read the developer's own config, which may sign every commit.
 */
const homeEnv = (home) => ({
  GIT_CEILING_DIRECTORIES: path.dirname(home),
  // A config of its own, empty: not the developer's, whose signing or hooks would run in a test that commits.
  GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  DATA_DIR: home, BIN_DIR: path.join(home, "bin"), SESSION_DIR: path.join(home, "sessions"), CHANNELS_DIR: path.join(home, "channels"),
  AGENT_HOME: path.join(home, "agent-home"), WORKSPACE_ROOT: path.join(home, "ws"), PI_CODING_AGENT_DIR: path.join(home, "agent"),
});

/**
 * The names pi takes a provider's key or a cloud login from (pi-ai's env-api-keys: `*_API_KEY`, `HF_TOKEN`, the
 * Anthropic and Copilot tokens, Google's and AWS's credentials). With one of them set, pi has a model it did not
 * have in a test, picks it, and a chat or a routine that is run for its error goes to the provider, with tools,
 * on the developer's account.
 */
const CREDENTIALS = /_API_KEY$|^ANTHROPIC_(AUTH|OAUTH)_TOKEN$|^HF_TOKEN$|^COPILOT_GITHUB_TOKEN$|^AWS_|^GOOGLE_(CLOUD_|APPLICATION_CREDENTIALS)|^GCLOUD_/;
export const withoutCredentials = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIALS.test(name)));

/**
 * A home for a test that loads the server's modules into its own process, as
 * `testHome` is for one that starts the server: this process's environment
 * points every folder into it, so nothing reaches the developer's own pi
 * settings or a portal's data, and it is removed when the file's tests end.
 * Call it before the modules are imported (they read the environment as they
 * load), and `await import(...)` them after it. Given the home of a server the
 * test starts, both work on the same database.
 */
export function inProcessHome(prefix, existing) {
  const home = existing ?? testHome(prefix);
  Object.assign(process.env, homeEnv(home));
  for (const name of Object.keys(process.env)) if (CREDENTIALS.test(name)) delete process.env[name];
  mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
  return home;
}

/**
 * What the server is started with: everything in `home`, no password, pi on the
 * host. `overrides` change any of it, a test of the login giving it a password.
 */
export const serverEnv = (home, port, overrides = {}) => ({
  ...withoutCredentials(process.env),
  PORT: String(port), ...homeEnv(home),
  PORTAL_PASSWORD: "", PORTAL_ALLOW_NO_PASSWORD: "1", EXECUTOR: "host", LLAMA_BASE_URL: "http://127.0.0.1:1",
  // The checkout a test server runs from is the developer's own: it does not fetch from its remote on a schedule.
  PORTAL_UPDATE_CHECK: "off",
  ...overrides,
});

/**
 * Runs `args` with this runtime to its end, with what it printed. One that is
 * still going after `ms` is stopped, and has code null: a test that meant it
 * to fail at once fails, rather than waiting for ever.
 */
export function runToEnd(args, env, { cwd, ms = 60_000 } = {}) {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const timer = setTimeout(() => child.kill(), ms);
  // "close", not "exit": by then everything it printed has been read.
  return new Promise((resolve) => child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); }));
}

/**
 * Starts the server and waits until it says it listens. A port from `freePort` is free only until something else
 * takes it, and that can be another test's server or a fake one before this server has opened its database: whatever
 * answers on the port is not the server that was started, so the line the server itself prints is what is waited for.
 * When it could not take the port, it is started again on another one. `port` is the one it listens on,
 * and `log()` what the server has printed so far. `entry` is the server's entry, where a test runs a copy of it from
 * another place.
 */
export async function startServer(env, tries = 5, entry = ENTRY) {
  for (let attempt = 1; ; attempt++) {
    const run = attempt === 1 ? env : { ...env, PORT: String(await freePort()) };
    const child = spawn(process.execPath, [entry], { env: run, stdio: ["ignore", "pipe", "pipe"] });
    started.push(child);
    let log = "";
    const listening = new RegExp(`pithagoras listening on :${run.PORT}\\b`);
    const outcome = await new Promise((resolve) => {
      const seen = () => { if (listening.test(log)) resolve("listening"); };
      child.stdout.on("data", (d) => { log += d; seen(); });
      child.stderr.on("data", (d) => { log += d; });
      // "close", not "exit": by then everything it printed has been read.
      child.once("close", () => resolve("exited"));
      setTimeout(() => resolve("silent"), 20_000).unref();
    });
    if (outcome === "listening") {
      const base = `http://127.0.0.1:${run.PORT}`;
      for (let i = 0; i < 200; i++) {
        try {
          if ((await fetch(`${base}/api/auth/status`)).ok) return { child, base, port: Number(run.PORT), log: () => log };
        } catch { /* not answering yet */ }
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (attempt < tries && /could not listen on .*(EADDRINUSE|address already in use)/.test(log)) continue;
    throw new Error(`the server did not start:\n${log}`);
  }
}
