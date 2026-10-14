import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../data-dir.js";

/**
 * The same browser, without a container.
 *
 * For deployments with no Docker socket — most often the portal run straight
 * from source, where a Chrome is already installed. Nothing is downloaded and
 * nothing is added to the image: if a browser is on the machine it is used, and
 * if it is not, this says so rather than pretending.
 *
 * The profile lives on the data volume exactly as the container's does, so the
 * agent's logins survive restarts either way.
 */

const CANDIDATES = [
  process.env.BROWSER_BINARY,
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean) as string[];

const PROFILE = path.resolve(DATA_DIR, "browser-profile");

/** The first candidate that exists, resolving bare names against PATH. */
export function findBinary(): string | null {
  for (const candidate of CANDIDATES) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const full = path.join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

let child: ChildProcess | null = null;

export const running = () => Boolean(child && child.exitCode === null);

export function status() {
  const binary = findBinary();
  return {
    available: Boolean(binary),
    binary,
    running: running(),
    // Headful when there is a display to put it on, which is the case worth
    // having: a headless browser is frequently refused by sign-in pages, and
    // signing in is the entire point of this.
    headless: !process.env.DISPLAY,
    profile: PROFILE,
  };
}

export function start(): void {
  if (running()) return;
  const binary = findBinary();
  if (!binary) throw new Error("No Chrome or Chromium found on this machine");

  mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--user-data-dir=${PROFILE}`,
    // Bound to loopback by default, and left that way: the port is
    // unauthenticated and whoever reaches it owns every account signed in.
    "--remote-debugging-port=9222",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (!process.env.DISPLAY) args.push("--headless=new");

  child = spawn(binary, args, { detached: false, stdio: "ignore" });
  child.on("exit", () => (child = null));
}

export function stop(): void {
  child?.kill("SIGTERM");
  child = null;
}
