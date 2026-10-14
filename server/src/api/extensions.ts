import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { piSettingsPath, readPiSettings, updatePiSettings } from "../pi-settings.js";
import { extensionStash, setExtensionStash } from "../db.js";
import { isFiltered, isSwitchedOff, setPackageEnabled, sourceOf } from "../extension-switch.js";
import { sessions } from "../session-manager.js";
import { clientHalf, packageKinds, packageThemes, serverHalf, type ClientHalf, type PackageKind, type PackageThemes, type ServerHalf } from "../extension-ui.js";
import { bundledPath } from "../bundled.js";
import { SUBAGENT_PACKAGE } from "../features.js";
import { isServing, serverFailure, serversSettled, syncServerHalves } from "../extension-host.js";

const run = promisify(execFile);

export interface DetectedSetting {
  key: string;
  value: unknown;
  configured: boolean;
}

export interface ExtensionInfo {
  spec: string;
  name: string;
  path?: string;
  scope?: string;
  description?: string;
  homepage?: string;
  version?: string;
  settings: DetectedSetting[];
  /**
   * Whether pi loads it. Absent where the portal cannot say, or cannot switch
   * it: a package the project brings is that project's to decide.
   */
  enabled?: boolean;
  /** Some of its files are off by hand; switching it off and on must not lose that. */
  filtered?: boolean;
  /** What it brings: something for pi, something the portal draws or runs, colours for the portal. Empty where its folder could not be read. */
  kinds: PackageKind[];
}

/** An extension that comes with the portal and is installed from its own folder. */
export interface ShippedExtension {
  name: string;
  version?: string;
  description?: string;
  kinds: PackageKind[];
  /** What it is installed by: its folder. */
  spec: string;
}

/**
 * The extensions in the portal's own `extensions` folder, each a package in a
 * folder of its own. Not the subagent tool: that one is switched in Settings →
 * Add-ons, which also keeps its settings.
 */
export function shippedExtensions(dir = bundledPath("extensions")): ShippedExtension[] {
  if (!dir) return [];
  const out: ShippedExtension[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    let meta: any;
    try {
      meta = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof meta?.name !== "string" || meta.name === SUBAGENT_PACKAGE) continue;
    out.push({
      name: meta.name,
      ...(typeof meta.version === "string" ? { version: meta.version } : {}),
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
      kinds: packageKinds(folder),
      spec: folder,
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * `pi list` nests by indentation: a scope heading, each package spec, then the
 * directory it was installed into.
 */
function parseList(output: string): { spec: string; path?: string; scope?: string }[] {
  const out: { spec: string; path?: string; scope?: string }[] = [];
  let scope: string | undefined;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0) {
      scope = text.replace(/packages:?$/i, "").trim() || undefined;
    } else if (indent <= 2) {
      // `pi list` says so after the source when the entry is an object, and
      // that is not part of the name pi takes back in `remove`.
      out.push({ spec: text.replace(/\s+\(filtered\)$/, ""), scope });
    } else {
      const last = out[out.length - 1];
      if (last && !last.path) last.path = text;
    }
  }
  return out;
}

/**
 * Find the settings keys an extension reads.
 *
 * pi has no schema for extension configuration — extensions simply pull keys
 * off the settings object (`const { llamaServerUrl } = settings`). So the keys
 * are recovered from the source, which is a heuristic: it can miss a key built
 * dynamically, and the UI says so rather than implying this list is complete.
 */
function detectSettingKeys(pkgPath: string): string[] {
  const keys = new Set<string>();
  const SKIP = new Set(["length", "constructor", "default", "prototype"]);

  const scan = (dir: string, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full, depth + 1);
        continue;
      }
      if (!/\.(ts|js|mjs|cjs)$/.test(entry.name)) continue;
      let src: string;
      try {
        if (statSync(full).size > 512 * 1024) continue;
        src = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      // const { a, b = x } = settings
      for (const m of src.matchAll(/\{([^{}]{0,300}?)\}\s*=\s*(?:\w*[sS]ettings)\b/g)) {
        for (const part of m[1].split(",")) {
          const key = part.split(/[:=]/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(key) && !SKIP.has(key)) keys.add(key);
        }
      }
      // settings.foo / settings["foo"]
      for (const m of src.matchAll(/\b\w*[sS]ettings(?:\.(\w+)|\[["'](\w+)["']\])/g)) {
        const key = m[1] || m[2];
        if (key && !SKIP.has(key) && !/^(get|set)[A-Z]/.test(key)) keys.add(key);
      }
    }
  };

  scan(pkgPath);
  return [...keys].sort();
}

/**
 * What `pi list` says, kept until the packages in settings.json change.
 *
 * Starting pi to ask takes a second or more, and Settings asks each time it
 * opens: its rail lists the extensions that have settings, and they arrived
 * after everything else had settled. What is installed only changes with the
 * packages list, which install, remove and switching all rewrite.
 */
let listed: { stamp: string; value: Promise<{ spec: string; path?: string; scope?: string }[]> } | undefined;
function installedPackages(settings: Record<string, unknown>) {
  const stamp = JSON.stringify(settings.packages ?? null);
  if (listed?.stamp !== stamp) {
    const value = run("pi", ["list"], { timeout: 60_000 }).then(({ stdout }) => parseList(stdout));
    listed = { stamp, value };
    value.catch(() => { if (listed?.value === value) listed = undefined; });
  }
  return listed.value;
}

/**
 * The packages this portal had switched on when it started, which is what it runs until it starts again: not what is
 * installed now, which an install changes at once. Asked for at the start (see server.ts), so the answer is the one of
 * that time; null until it is known.
 */
let loadedAtStart: string[] | null = null;
let loadedAsked = false;
export const loadedExtensions = (): string[] | null => loadedAtStart;
export async function noteLoadedExtensions(): Promise<void> {
  if (loadedAsked) return;
  loadedAsked = true;
  try {
    const settings = readPiSettings();
    const entries = Array.isArray(settings.packages) ? settings.packages : [];
    loadedAtStart = (await installedPackages(settings))
      .filter((pkg) => {
        const entry = entries.find((e) => sourceOf(e) === pkg.spec);
        return entry === undefined || !isSwitchedOff(entry);
      })
      .map((pkg) => pkg.spec.replace(/^(npm:|git:)/, ""));
  } catch {
    loadedAsked = false;
  }
}

/**
 * When the files a scan reads last changed, and how many there are — the
 * same files detectSettingKeys reads, only looked at, not read.
 */
function sourceStamp(dir: string, depth = 0): string {
  if (depth > 4) return "";
  let newest = 0, count = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const deeper: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) deeper.push(sourceStamp(full, depth + 1));
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
      try { newest = Math.max(newest, statSync(full).mtimeMs); count++; } catch { /* gone meanwhile */ }
    }
  }
  return [`${newest}:${count}`, ...deeper].join(",");
}

/**
 * The keys a package reads, found once per version of it rather than on
 * every look. One from npm or git changes only by being installed again,
 * which rewrites its package.json. One from a folder of its own is being
 * worked on: an edit to its code is seen at the next look.
 */
const keysFound = new Map<string, { stamp: string; keys: string[] }>();
export function settingKeysOf(dir: string, installed: boolean): string[] {
  let stamp: string | undefined;
  if (installed) {
    try { stamp = String(statSync(path.join(dir, "package.json")).mtimeMs); } catch { /* looked at as a folder */ }
  }
  stamp ??= sourceStamp(dir);
  const had = keysFound.get(dir);
  if (had && had.stamp === stamp) return had.keys;
  const keys = detectSettingKeys(dir);
  keysFound.set(dir, { stamp, keys });
  return keys;
}

/**
 * Switch an installed package on or off in pi's settings, keeping a filter
 * aside for switching it back. False where it is not listed there.
 */
export async function switchPackage(spec: string, enabled: boolean): Promise<boolean> {
  let stashed: ReturnType<typeof extensionStash> | undefined;
  await updatePiSettings(
    (all) => {
      // The stash is read and written in turn with the settings file: two
      // switches at once would otherwise both start from the same stash,
      // and the later write would drop what the earlier one kept.
      const changed = setPackageEnabled(Array.isArray(all.packages) ? all.packages : [], spec, enabled, extensionStash());
      if (!changed) return;
      all.packages = changed.packages;
      stashed = changed.stash;
    },
    // Written only once the file is: a failed write leaves both as they were.
    () => stashed && setExtensionStash(stashed),
  );
  return stashed !== undefined;
}

/**
 * The halves the portal loads, a browser half into its page and a server half
 * into its own process: of the packages its own settings install, the ones
 * switched on. Never a package a folder brings: an agent can write that
 * folder, and what it put there would run in the page of everyone who opens
 * the portal, or in the portal itself.
 */
async function halves(): Promise<{ clients: ClientHalf[]; servers: ServerHalf[]; themed: PackageThemes[] }> {
  const settings = readPiSettings();
  const listed = Array.isArray(settings.packages) ? settings.packages : [];
  const clients: ClientHalf[] = [];
  const servers: ServerHalf[] = [];
  const themed: PackageThemes[] = [];
  // Two packages under one name: the first is the one, whole. Never one's page with the other's server.
  const taken = new Set<string>();
  for (const pkg of await installedPackages(settings)) {
    if (!pkg.path || (pkg.scope && !/^user/i.test(pkg.scope))) continue;
    const entry = listed.find((e) => sourceOf(e) === pkg.spec);
    if (entry === undefined || isSwitchedOff(entry)) continue;
    const client = clientHalf(pkg.path), server = serverHalf(pkg.path), themes = packageThemes(pkg.path);
    const name = (client ?? server ?? themes)?.name;
    if (!name || taken.has(name)) continue;
    taken.add(name);
    if (client) clients.push(client);
    if (server) servers.push(server);
    if (themes) themed.push(themes);
  }
  return { clients, servers, themed };
}

const clientHalves = async () => (await halves()).clients;

/**
 * Bring the server halves that run in line with what is installed and switched
 * on: as the portal starts, and whenever a package is installed, removed,
 * updated or switched.
 */
export async function syncExtensionServers(): Promise<void> {
  await syncServerHalves((await halves()).servers);
}

/**
 * The same, after something else changed which packages there are. That
 * change was made, whatever becomes of this: where the packages cannot be
 * listed just now it is said, and the server halves are as they were until
 * the next change or start.
 */
export const followPackages = (): Promise<void> =>
  syncExtensionServers().catch((e) => console.error("[extensions] could not bring the server halves in line with what is installed:", e));

/** Where a page fetches a file of a package's web folder from. */
const clientUrl = (half: ClientHalf, file: string) =>
  `/api/extension-ui/${[...half.name.split("/"), ...file.split("/")].map(encodeURIComponent).join("/")}?v=${half.rev}`;

export function extensionsRouter(): Router {
  const router = express.Router();

  router.get("/extension-ui", async (_req, res) => {
    try {
      // What is being started or stopped is waited for: a page is told where a server half's routes are only once they are there.
      await serversSettled();
      const { clients, servers, themed } = await halves();
      const names = [...new Set([...clients, ...servers, ...themed].map((half) => half.name))];
      res.json({
        extensions: names.map((name) => {
          const client = clients.find((half) => half.name === name);
          const server = servers.find((half) => half.name === name);
          const themes = themed.find((half) => half.name === name);
          const failure = server && serverFailure(name);
          return {
            name,
            version: (client ?? server ?? themes)!.version,
            ...(themes ? { themes: themes.themes } : {}),
            ...(client ? { entry: clientUrl(client, client.entry) } : {}),
            ...(client?.style ? { style: clientUrl(client, client.style) } : {}),
            // Where its server half's own routes are, when it has one that is running.
            ...(server && isServing(name) ? { server: `/api/x/${name.split("/").map(encodeURIComponent).join("/")}` } : {}),
            ...(failure ? { serverError: failure } : {}),
          };
        }),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // A file of a package's web folder. The package's name may have a slash in it (`@scope/name`), so it is found by
  // what the path starts with.
  router.get("/extension-ui/*file", async (req, res) => {
    try {
      const asked = (req.params as unknown as { file: string[] }).file.join("/");
      const half = (await clientHalves()).find((h) => asked.startsWith(`${h.name}/`));
      const file = half ? asked.slice(half.name.length + 1) : "";
      if (!half || !file) return res.status(404).json({ error: "Not found" });
      // Asked for by the module's revision, so what a page holds is never stale; checked each time all the same.
      res.sendFile(file, { root: half.dir, dotfiles: "deny", cacheControl: false, headers: { "Cache-Control": "no-cache" } }, (error) => {
        if (error && !res.headersSent) res.status(404).json({ error: "Not found" });
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/extensions", async (_req, res) => {
    try {
      const settings = readPiSettings();
      const packages = await installedPackages(settings);
      const listed = Array.isArray(settings.packages) ? settings.packages : [];

      const infos: ExtensionInfo[] = packages.map((pkg) => {
        const info: ExtensionInfo = {
          spec: pkg.spec,
          name: pkg.spec.replace(/^(npm:|git:)/, ""),
          path: pkg.path,
          scope: pkg.scope,
          settings: [],
          kinds: pkg.path ? packageKinds(pkg.path) : [],
        };

        if (!pkg.scope || /^user/i.test(pkg.scope)) {
          const entry = listed.find((e) => sourceOf(e) === pkg.spec);
          if (entry !== undefined) {
            info.enabled = !isSwitchedOff(entry);
            if (isFiltered(entry)) info.filtered = true;
          }
        }

        if (pkg.path && existsSync(path.join(pkg.path, "package.json"))) {
          try {
            const meta = JSON.parse(readFileSync(path.join(pkg.path, "package.json"), "utf8"));
            info.name = meta.name ?? info.name;
            info.description = meta.description;
            info.homepage = meta.homepage;
            info.version = meta.version;
          } catch {
            // metadata is a nicety; keep going without it
          }
          // The MCP adapter keeps its settings in mcp.json, not pi's
          // settings.json. The key scanner finds them all the same, and a form
          // built from them would write keys the adapter never reads — so it
          // gets no config page here. Settings → MCP edits the real file.
          const keys = info.name === "pi-mcp-adapter" ? [] : settingKeysOf(pkg.path, /^(npm|git):/.test(pkg.spec));
          for (const key of keys) {
            info.settings.push({
              key,
              value: settings[key] ?? "",
              configured: Object.prototype.hasOwnProperty.call(settings, key),
            });
          }
        }
        return info;
      });

      res.json({ extensions: infos, settingsPath: piSettingsPath() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** What comes with the portal and can be installed from its own folder. */
  router.get("/extensions/shipped", (_req, res) => {
    try {
      res.json({ extensions: shippedExtensions() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Switch an installed package off, or on again, without uninstalling it — the
   * way `pi config` does, by emptying what it may load. Open conversations are
   * reloaded so the change is there without a restart.
   */
  router.put("/extensions/enabled", async (req, res) => {
    const { spec, enabled } = req.body ?? {};
    if (typeof spec !== "string" || !spec || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "spec and enabled are required" });
    }
    try {
      const found = await switchPackage(spec, enabled);
      if (!found) return res.status(404).json({ error: "That package is not installed for this user" });
      await followPackages();
      const { reloaded, waiting } = await sessions.reloadIdle();
      res.json({ ok: true, enabled, reloaded, waiting });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Write one settings key. Empty string removes it, so a field can be cleared. */
  router.put("/extensions/settings", async (req, res) => {
    const { key, value } = req.body ?? {};
    if (typeof key !== "string" || !/^[A-Za-z_$][\w$]*$/.test(key)) {
      return res.status(400).json({ error: "Invalid settings key" });
    }
    try {
      // Through the same read, backup and write chain as every other change of the file.
      const settings = await updatePiSettings((all) => {
        if (value === "" || value === null || value === undefined) delete all[key];
        else all[key] = value;
      });
      res.json({ ok: true, settings });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
