import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSetting, putSetting } from "./db.js";
import { npmName, sourceOf } from "./extension-switch.js";
import { readPiSettings } from "./pi-settings.js";

/**
 * pi-web-access, the web search package many portals have, hides its tools behind a tool of its own, `web_enable`,
 * which switches them on when the model calls it: its `toolActivation` "dynamic", and "auto" (its default) with a model
 * that can take tools in mid-chat. The portal has a way of its own to the tools it does not offer one by one
 * (`tool_search`, and the marks in Settings → Tools), and the two in a row had the model find a tool that switches on the
 * tools it wanted, past what the marks said. So the portal makes them "eager", and its marks decide: once, as it starts
 * with the package installed, or as the package is installed. What somebody sets after that stands.
 */

/** The setting that says it was done. */
const DONE = "web_access_eager";

/** pi-web-access's `web-search.json`, where it looks for it (getWebSearchConfigDir in its utils.ts). */
export function webSearchConfigPath(): string {
  const file = (dir: string) => path.join(dir, "web-search.json");
  const explicit = process.env.PI_CODING_AGENT_DIR;
  if (explicit) return file(explicit);
  const legacy = path.join(os.homedir(), ".pi");
  const xdg = process.env.XDG_CONFIG_HOME;
  const first = xdg ? path.join(xdg, "pi") : path.join(os.homedir(), ".pi", "agent");
  return file([first, legacy].find((dir) => existsSync(file(dir))) ?? first);
}

/** The first version with `toolActivation` "eager". Before it, `web_enable` came with 0.31.0 and could not be turned off, and the key means nothing. */
const EAGER_SINCE = [0, 33, 0];

/** Whether a version (`1.2.3`, anything after it ignored) is at least `least`; false where it is not one. */
function atLeast(version: string, least: number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== least[i]) return parts[i] > least[i];
  return true;
}

/**
 * The version of pi-web-access that pi has installed, from the package's own package.json (`installed` is what `pi list`
 * says: each package's spec and folder). The packages are updated apart from pi, which the portal fixes: a spec without
 * a version takes the newest at each update, so the portal cannot assume one. Undefined where pi cannot say.
 */
function installedVersion(installed: readonly { spec: string; path?: string; scope?: string }[] | undefined): string | undefined {
  const found = (installed ?? []).filter((pkg) => npmName(pkg.spec) === "pi-web-access" && pkg.path);
  const own = found.find((pkg) => /^user/i.test(pkg.scope ?? "")) ?? found[0];
  try {
    const version = own?.path ? (JSON.parse(readFileSync(path.join(own.path, "package.json"), "utf8")) as { version?: unknown }).version : undefined;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make pi-web-access's tools eager, once it is installed: see above. `installed`: what pi has installed (`pi list`).
 * Only where the version installed knows the value: one before 0.33.0, or one pi cannot name, is tried again after the
 * next install or update. Not where the file takes pi's own deferred route (`toolExposure` other than "direct", or
 * `toolActivation` "none", from 0.42.0 and 0.44.0), which pi-web-access refuses to load with "eager". A file that
 * cannot be read is left alone, and tried again at the next start.
 */
export function eagerWebAccess(installed?: readonly { spec: string; path?: string; scope?: string }[]): void {
  if (getSetting(DONE)) return;
  const packages = readPiSettings().packages;
  if (!Array.isArray(packages) || !packages.some((entry) => npmName(sourceOf(entry) ?? "") === "pi-web-access")) return;
  const version = installedVersion(installed);
  if (!version || !atLeast(version, EAGER_SINCE)) return;
  const file = webSearchConfigPath();
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not an object");
    config = parsed as Record<string, unknown>;
  } catch (e) {
    console.warn(`[portal] pi-web-access: ${file} cannot be read (${(e as Error).message}), so its tools are left as it says.`);
    return;
  }
  const was = config.toolActivation;
  const exposure = config.toolExposure;
  if (was === "none" || (exposure !== undefined && exposure !== "direct")) {
    console.log(
      `[portal] pi-web-access: its tools are left as ${file} says (toolExposure ${JSON.stringify(exposure)}, toolActivation ${JSON.stringify(was)}): that is pi's own deferred route, which pi-web-access does not take with "eager".`,
    );
  } else if (was !== "eager") {
    // It holds the keys of the search services: the copy is as private as the file, or the person's alone where there is none.
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
    const next = `${file}.${process.pid}.tmp`;
    writeFileSync(next, `${JSON.stringify({ ...config, toolActivation: "eager" }, null, 2)}\n`, { mode });
    renameSync(next, file);
    console.log(
      `[portal] pi-web-access: its tools are offered as the portal's marks say now, not behind its own web_enable: toolActivation is "eager" in ${file} (it was ${was === undefined ? "not set" : JSON.stringify(was)}).`,
    );
  }
  putSetting(DONE, "1");
}
