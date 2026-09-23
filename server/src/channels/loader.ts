import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ChannelField {
  key: string;
  label: string;
  hint?: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface ChannelManifest {
  id: string;
  label: string;
  blurb?: string;
  fields: ChannelField[];
}

export interface LoadedChannel extends ChannelManifest {
  /** npm package name. */
  packageName: string;
  version?: string;
  /** Shipped with the portal, so it cannot be uninstalled. */
  builtin: boolean;
  dir: string;
  /** Present only when the module loaded and exports a usable start(). */
  start?: (ctx: unknown) => Promise<{
    stop: () => Promise<void> | void;
    /** Optional. A transport that can only answer, like a webhook, omits it. */
    send?: (
      target: string,
      text: string,
      /**
       * Optional one-tap replies. Each is exactly the message that would be
       * typed, so a channel that renders them as buttons and one that ignores
       * them entirely behave identically — the text protocol stays the only
       * protocol, and buttons are presentation over it.
       */
      options?: { label: string; reply: string }[]
    ) => Promise<void> | void;
    /**
     * Optional. Render a question the way this platform renders questions —
     * Telegram has buttons, Slack has blocks — and capture the answer.
     *
     * Returning null means "not something I can present", and the portal falls
     * back to asking in plain text. That is the default, not a failure: it is
     * how a channel with no such affordance behaves, and how any channel
     * behaves for a question that does not fit buttons.
     */
    prompt?: (
      target: string,
      request: { id: string; method: string; question: string; options?: string[] }
    ) => Promise<{ value?: unknown; cancelled?: boolean } | null>;
  }>;
}

export interface BrokenChannel {
  packageName: string;
  dir: string;
  builtin: boolean;
  error: string;
}

/** Where third-party packages are installed. Builtins ship inside the image. */
export const channelsDir = (): string => {
  const dir = path.resolve(process.env.CHANNELS_DIR || "/data/channels");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * The repo's own `channels/` directory. Resolved relative to the compiled file
 * so it works both from `dist` and from a source run.
 */
const builtinDir = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, "../../../channels"), // dist/channels -> repo root
    path.resolve(here, "../../channels"),
    path.resolve(process.cwd(), "channels"),
    path.resolve(process.cwd(), "../channels"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), "channels");
};

const isChannelPackage = (meta: any) =>
  Boolean(meta?.pithagoras?.channel) || /^pithagoras-channel-/.test(meta?.name ?? "");

function candidateDirs(): { dir: string; builtin: boolean }[] {
  const out: { dir: string; builtin: boolean }[] = [];

  const scan = (root: string, builtin: boolean) => {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const dir = path.join(root, name);
      // npm scopes nest one level deeper.
      if (name.startsWith("@")) {
        scan(dir, builtin);
        continue;
      }
      if (existsSync(path.join(dir, "package.json"))) out.push({ dir, builtin });
    }
  };

  scan(builtinDir(), true);
  scan(path.join(channelsDir(), "node_modules"), false);
  return out;
}

function validate(manifest: any, packageName: string): ChannelManifest {
  if (!manifest || typeof manifest !== "object") throw new Error("no manifest export");
  const { id, label, blurb, fields } = manifest;
  if (typeof id !== "string" || !/^[a-z0-9][\w-]*$/i.test(id)) {
    throw new Error(`manifest.id must be a simple identifier (got ${JSON.stringify(id)})`);
  }
  if (typeof label !== "string" || !label) throw new Error("manifest.label is required");
  if (!Array.isArray(fields)) throw new Error("manifest.fields must be an array");

  for (const f of fields) {
    if (!f || typeof f.key !== "string" || !/^[A-Za-z_$][\w$]*$/.test(f.key)) {
      throw new Error(`field key must be an identifier (in ${packageName})`);
    }
    if (typeof f.label !== "string" || !f.label) {
      throw new Error(`field "${f.key}" needs a label (in ${packageName})`);
    }
  }
  return { id, label, blurb, fields };
}

let cache: { channels: LoadedChannel[]; broken: BrokenChannel[] } | null = null;

/**
 * Load every channel package: the builtins in the repo, plus anything installed
 * under CHANNELS_DIR. A package that fails to load is reported rather than
 * dropped, so a typo in a third-party channel is visible instead of silent.
 */
export async function loadChannels(force = false): Promise<{
  channels: LoadedChannel[];
  broken: BrokenChannel[];
}> {
  if (cache && !force) return cache;

  const channels: LoadedChannel[] = [];
  const broken: BrokenChannel[] = [];
  const seen = new Map<string, string>();

  for (const { dir, builtin } of candidateDirs()) {
    let meta: any;
    try {
      meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch (e) {
      continue;
    }
    if (!isChannelPackage(meta)) continue;

    const packageName = meta.name ?? path.basename(dir);
    try {
      const entry = path.resolve(dir, meta.main || "index.js");
      // Cache-busted so a reinstall of the same version is picked up without a
      // restart — ESM would otherwise serve the module it already imported.
      const mod: any = await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
      const manifest = validate(mod.manifest ?? mod.default?.manifest, packageName);

      const clash = seen.get(manifest.id);
      if (clash) throw new Error(`channel id "${manifest.id}" is already provided by ${clash}`);
      seen.set(manifest.id, packageName);

      const start = mod.start ?? mod.default?.start;
      channels.push({
        ...manifest,
        packageName,
        version: meta.version,
        builtin,
        dir,
        start: typeof start === "function" ? start : undefined,
      });
    } catch (e) {
      broken.push({ packageName, dir, builtin, error: (e as Error).message });
    }
  }

  cache = { channels, broken };
  return cache;
}

export const invalidate = () => {
  cache = null;
};

/**
 * Install a channel package with npm, which already understands every spec form
 * worth supporting: `user/repo`, `github:user/repo#tag`, a git URL, an https
 * tarball, or a plain npm name.
 */
export async function installChannelPackage(spec: string): Promise<string> {
  const dir = channelsDir();
  if (!existsSync(path.join(dir, "package.json"))) {
    // npm needs somewhere to record the dependency, or it walks up and installs
    // into whatever project happens to be above this directory.
    const stub = { name: "pithagoras-channels", private: true, dependencies: {} };
    mkdirSync(dir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(stub, null, 2) + "\n");
  }

  const { stdout, stderr } = await run(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", spec],
    { cwd: dir, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
  );
  invalidate();
  return (stdout || stderr || "").trim();
}

export function isPackageName(name: string): boolean {
  return name.length <= 214 && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}

export function channelPackageTarget(packageName: string): string {
  if (!isPackageName(packageName)) throw new Error("Invalid package name");
  const root = path.resolve(channelsDir(), "node_modules");
  const target = path.resolve(root, packageName);
  if (!target.startsWith(root + path.sep)) throw new Error("Invalid package path");
  const parent = path.dirname(target);
  if (existsSync(parent) && existsSync(root)) {
    const realRoot = realpathSync(root), realParent = realpathSync(parent);
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      throw new Error("Package scope escapes node_modules");
    }
  }
  return target;
}

export async function removeChannelPackage(packageName: string): Promise<void> {
  const target = channelPackageTarget(packageName);
  const dir = channelsDir();
  await run("npm", ["remove", "--", packageName], { cwd: dir, timeout: 120_000 }).catch(() => {
    // npm remove fails if it was never recorded as a dependency; fall through
    // to deleting the directory so a half-installed package can still be
    // cleared rather than being stuck in the list forever.
  });
  channelPackageTarget(packageName); // Recheck after npm may have changed the tree.
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  invalidate();
}
