/**
 * pithagoras-office container lifecycle: the OnlyOffice Document Server container behind every edit.
 *
 * The container is plain Docker (pithagoras-docker) with:
 * - a pinned image tag from settings (never :latest -- plan 5.1),
 * - the portal's shared network (`HostConfig.NetworkMode = await docker.sharedNetwork()`), so the DS container
 *   and the in-process loopback listener reach each other on 127.0.0.1 in BOTH deployment shapes (plan 5.1/5.2),
 * - a named volume for /var/www/onlyoffice/Data (DS's internal storage; plan 5.1),
 * - exactly the four JWT env vars the 10.x community image documents (plan 4): one secret covers config tokens
 *   AND callback verification in every direction, so a per-direction setup is unnecessary.
 *
 * The DS origin -- where the editor page and document.url point -- is fixed by the deployment shape (there are no
 * published ports under shared networking; the stock nginx listens on :80 of the whole shared netns) and is
 * recorded in ds.json at create time, which stays the single source of truth for it:
 * - host mode  -> "http://127.0.0.1" (DS sits on the machine's own loopback).
 * - container:<id> mode -> the recorded origin is the string `container:<id>` itself -- NOT a URL yet. The plan
 *   defers browser reach in that shape to the M0 spike-2 decision (nginx bind override vs portal reverse-proxy vs
 *   declared local-only), so there is no honest browser-facing URL to write at create time; this marker carries the
 *   portal container id so a later wave can turn it into one. DS-side fetches (document.url, callback) use the
 *   loopback listener's own address and never read this field.
 *
 * What the plan does NOT mandate here: a HostConfig.Memory cap. The ~4 GB number in the plan is a RAM RECOMMENDATION
 * ("system requirements RAM >= 4 GB", surfaced as a warning before first start), not an enforced limit -- no cap is
 * set, so a document save under load cannot be OOM-killed mid-write. (Documented divergence.)
 *
 * Container identity/adopt: `containers.get(DS_NAME)` finds one the extension made; if it is there we NEVER recreate
 * or restart it -- a running one yields { started: false }, a stopped one is simply started. A container the portal
 * ran before this extension existed (ownerless) is still usable through the same name; adopting it into this
 * extension's ownership is left to the Docker Settings page (out of scope for the lifecycle here).
 *
 * User intent: `stopContainer` records a user-stopped marker FILE in the data dir (`user-stopped`) -- a file, not
 * memory, so a portal restart does not revive what the user stopped (plan 5.1: "lookAfter keeps a user-started
 * container alive but never resurrects one the user stopped"). Any `ensureContainer` success clears it: an explicit
 * ensure is by definition a user start request (settings enable / POST /container/start), so self-clearing keeps the
 * two functions consistent without a second "unstop" call.
 *
 * Module state: `pullState` (the last pull progress reported to status()) is plain module scope on purpose. The
 * server half outlives re-imports within one process, and the in-memory pull position is ephemeral by contract
 * ("held in memory", plan 5.1) -- a restart simply starts with no progress to show until the next ensure.
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir, docker as hostDocker, portal } from "./host";
import { loadSettings } from "./settings";
import type { ContainerInfo, Docker, PullState } from "../../docker/src/api";

/** The DS container, by that name: the adopt key of `containers.get` and every lifecycle call. */
export const DS_NAME = "pithagoras-office-ds";
/** The named volume bound at /var/www/onlyoffice/Data (DS's internal storage). */
export const DS_VOLUME = "pithagoras-office-ds-data";
const DS_DATA_PATH = "/var/www/onlyoffice/Data";
/** Where the version of a running server is read from inside the container. */
const GIT_VERSION_FILE = "/var/www/onlyoffice/documentserver/GitVersion.json";

/** The marker file that records "the user stopped it": lookAfter must not revive it. Lives in the data dir so the
 * intent survives a portal restart. */
export const USER_STOPPED_FILE = "user-stopped";

type DsRecord = { containerId: string; origin: string; imageTag: string };

/** The last pull progress, in memory only, so status() can report it without re-pulling (contract + plan 5.1). */
let pullState: PullState | null = null;

/** One log line: portal().log where the server half started it, console.error elsewhere -- lazy, so unit tests that
 * pass explicit docker/root never touch portal() at all. */
function log(line: string): void {
  try {
    portal().log(`pithagoras-office: ${line}`);
  } catch {
    console.error(`[pithagoras-office] ${line}`);
  }
}

function noDocker(): Error {
  return Object.assign(new Error("no_docker"), { code: "no_docker" });
}

/** docker ?? host.docker(), guarded: undefined or unreachable -> the no_docker error, as the contract fixes it. */
async function reachable(docker?: Docker): Promise<Docker> {
  const d = docker ?? hostDocker();
  if (!d || !(await d.available())) throw noDocker();
  return d;
}

function resolvedRoot(root?: string): string {
  return root ?? dataDir();
}

/** The exact JWT env of the DS container (plan 4: four vars, one secret, covering every direction). The secret is
 * the trimmed content of dataDir()/jwt-secret, read HERE independently (contract amendment; server.ts creates the
 * file at boot, so a missing file surfaces as its plain fs error). */
function dsEnv(root: string): string[] {
  const secret = fs.readFileSync(path.join(root, "jwt-secret"), "utf8").trim();
  return [
    "JWT_ENABLED=true",
    `JWT_SECRET=${secret}`,
    "JWT_HEADER=X-Auth-Token",
    "JWT_IN_BODY=false",
  ];
}

function writeAtomic(dest: string, bytes: Buffer): void {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}

/** ds.json -- the single source of truth for container id and origin (written on every ensure). */
export function readDsRecord(root?: string): DsRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(resolvedRoot(root), "ds.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.containerId !== "string" || typeof r.origin !== "string" || typeof r.imageTag !== "string") return null;
  return { containerId: r.containerId, origin: r.origin, imageTag: r.imageTag };
}

function dsRecordPath(root: string): string {
  return path.join(root, "ds.json");
}

/** Whether the user-stopped marker is present. */
export function userStopped(root?: string): boolean {
  try {
    fs.accessSync(path.join(resolvedRoot(root), USER_STOPPED_FILE));
    return true;
  } catch {
    return false;
  }
}

function clearUserStopped(root: string): void {
  fs.rmSync(path.join(root, USER_STOPPED_FILE), { force: true });
}

/** The named volume for /var/www/onlyoffice/Data, created once: check `volumes.list()` first and create when absent.
 * A concurrent creation surfaces as DockerError status 409 ("already exists") -- or the API keeps the existing own
 * volume by that name outright (its documented behavior) -- both are swallowed, anything else propagates. */
async function ensureVolume(d: Docker): Promise<void> {
  const listed = await d.volumes.list();
  if (listed.some((v) => v.name === DS_VOLUME)) return;
  try {
    await d.volumes.create(DS_VOLUME);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const alreadyExists = err.status === 409 || /already exists/i.test(err.message ?? "");
    if (!alreadyExists) throw e;
  }
}

/**
 * Image ensured, container present and running: `{ started: false }` where one already ran (never recreated or
 * restarted), else it is made -- volume first, then `containers.create(DS_NAME, spec)` under the exact name (the
 * wrapper takes the name as its own parameter, not a field of the Docker create body) -- and started. ds.json is
 * rewritten on every success so it always reflects this container and the current deployment shape.
 */
// Concurrency guard: serialize the WHOLE ensure so two simultaneous callers (portal start + a status poller)
// cannot race create/start/ds.json. Cleared in finally so a failed run never poisons the next attempt.
let ensuring: Promise<{ started: boolean }> | null = null;

export function ensureContainer(
  docker?: Docker,
  onPull?: (state: PullState) => void,
  root?: string,
): Promise<{ started: boolean }> {
  ensuring ??= ensureContainerOnce(docker, onPull, root).finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function ensureContainerOnce(
  docker?: Docker,
  onPull?: (state: PullState) => void,
  root?: string,
): Promise<{ started: boolean }> {
  const d = await reachable(docker);
  const r = resolvedRoot(root);
  const tag = loadSettings(r).imageTag;

  // One pull for the image at a time, whoever asks; progress held in memory for status() AND handed to onPull.
  await d.images.ensure(tag, (state) => {
    pullState = state;
    onPull?.(state);
  });

  // The deployment shape decides both the NetworkMode and the recorded origin (host: "http://127.0.0.1",
  // container:<id>: that string itself, turned into a real URL by whatever M0 spike-2 picks).
  const networkMode = await d.sharedNetwork();

  let containerId: string;
  let existing = await d.containers.get(DS_NAME);
  // A changed imageTag applies at the next start: a stopped (or created-but-never-started) container left from an
  // older tag is removed so the creation path below rebuilds it with the CURRENT image. A running container is
  // never touched -- no surprise restart; it picks up the new image at its next stop.
  if (existing && existing.state !== "running" && existing.image !== tag) {
    await d.containers.remove(DS_NAME);
    existing = undefined; // let the creation path below recreate it with the new image
  }
  if (!existing) {
    await ensureVolume(d);
    const spec = {
      Image: tag,
      Env: dsEnv(r),
      HostConfig: {
        NetworkMode: networkMode,
        Binds: [`${DS_VOLUME}:${DS_DATA_PATH}`],
      },
    };
    containerId = (await d.containers.create(DS_NAME, spec)).id;
  } else {
    // Adopted as-is by name: no recreate, no restart. Its volume is already bound at that path.
    containerId = existing.id;
  }

  const started = !existing || existing.state !== "running";
  if (started) await d.containers.start(DS_NAME);

  writeAtomic(dsRecordPath(r), Buffer.from(JSON.stringify({ containerId, origin: networkMode === "host" ? "http://127.0.0.1" : networkMode, imageTag: tag }, null, 2) + "\n"));
  // An explicit ensure is a start request from the user: whatever stopped it before, keep it running from now on.
  clearUserStopped(r);
  return { started };
}

/** Stops the container by name and records the user-stopped intent (marker file, BEFORE the stop, so a lookAfter in
 * flight cannot race the user back into a revive). A missing or already-exited container needs no stop; the intent
 * stays recorded -- the user asked for "kept stopped", which is exactly what lookAfter honors. */
export async function stopContainer(docker?: Docker, root?: string): Promise<void> {
  const d = await reachable(docker);
  const r = resolvedRoot(root);
  fs.mkdirSync(r, { recursive: true });
  writeAtomic(path.join(r, USER_STOPPED_FILE), Buffer.from("user stopped the document server\n"));
  const existing = await d.containers.get(DS_NAME);
  if (existing && existing.state !== "exited") await d.containers.stop(DS_NAME);
}

/**
 * The running version: exactly `cat /var/www/onlyoffice/documentserver/GitVersion.json` in the container -- the
 * build file the stock image ships, whose DocEditorVersion is what DS reports about itself (the plan only says
 * "exec into container"; M0 re-verifies the path on the pinned tag). Never an error: a probe failure just leaves
 * `version` absent.
 */
async function probeVersion(d: Docker): Promise<string | undefined> {
  try {
    const res = await d.containers.exec(DS_NAME, ["cat", GIT_VERSION_FILE], { timeoutMs: 10_000 });
    if (res.exitCode !== 0) return undefined;
    const body = JSON.parse(res.output.replace(/^\uFEFF/, "").trim()) as Record<string, unknown>;
    const version = body.DocEditorVersion ?? body.Version;
    return typeof version === "string" && version ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Container state for the status block: absent or exited/created -> "stopped"; otherwise Docker's own inspect word
 * (with `State.Starting` folded in as "starting"). The current memory usage is read from the same inspect body's
 * top-level `Memory` where present. Pull progress comes from the in-memory last state of an ensure.
 */
export async function status(
  docker?: Docker,
  root?: string,
): Promise<{ state: string; version?: string; memBytes?: number; pull?: PullState | null }> {
  const out: { state: string; version?: string; memBytes?: number; pull?: PullState | null } = {
    state: "stopped",
    pull: pullState ? { ...pullState } : null,
  };
  let d: Docker | undefined;
  try {
    d = await reachable(docker);
  } catch {
    return out; // no docker here: the container is as good as stopped from our seat
  }

  let existing: ContainerInfo | undefined;
  try {
    existing = await d.containers.get(DS_NAME);
  } catch {
    existing = undefined;
  }
  if (!existing || existing.state === "exited" || existing.state === "created") return out;

  let inspected: Record<string, unknown> | undefined;
  try {
    inspected = await d.containers.inspect(DS_NAME);
  } catch {
    inspected = undefined;
  }
  const st = (inspected?.State ?? null) as { Status?: string; Starting?: boolean } | null;
  if (!st || typeof st.Status !== "string") {
    // The list view said something and inspect is silent: pass the list word through.
    out.state = existing.state;
    return out;
  }
  out.state = st.Status === "running" && st.Starting ? "starting" : st.Status === "exited" ? "stopped" : st.Status;

  const mem = inspected?.Memory;
  if (typeof mem === "number" && mem > 0) out.memBytes = mem;
  if (out.state === "running") {
    const version = await probeVersion(d);
    if (version) out.version = version;
  }
  return out;
}

/**
 * Fire-and-forget: settings enabled, user-stopped intent clear, container not running -> ensureContainer. Every
 * failure lands as one log line (never a throw -- it is called from the boot settle and the 30 s unref'd interval).
 */
export function lookAfter(docker?: Docker, root?: string): void {
  void (async () => {
    let d: Docker;
    let r: string;
    try {
      d = await reachable(docker);
      r = resolvedRoot(root);
    } catch (e) {
      log(`lookAfter skipped: ${(e as Error).message}`);
      return;
    }
    try {
      if (!loadSettings(r).enabled) return;
      if (userStopped(r)) return;
      const existing = await d.containers.get(DS_NAME);
      if (existing?.state === "running") return;
      await ensureContainer(d, undefined, r);
    } catch (e) {
      log(`could not look after the document server container: ${(e as Error).message}`);
    }
  })();
}
