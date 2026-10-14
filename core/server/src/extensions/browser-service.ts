import { randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import { browserCdp } from "../api/mcp.js";
import { getSetting, putSetting } from "../db.js";
import { containerAction, containerState, dockerAvailable, ensureImage, imagePresent, request, type PullState } from "./docker.js";
import * as local from "./browser-local.js";

/**
 * The agent's browser, as something the portal installs rather than something
 * every deployment carries.
 *
 * It used to be a service in docker-compose.yml, which meant everyone who never
 * wanted a browser still had it in their file, still had to know why it was
 * there, and — for a while — could not start the portal without setting its
 * password. Installed from the UI instead: nothing exists until somebody asks,
 * and removing it leaves no trace but the profile.
 */

export const IMAGE = "lscr.io/linuxserver/chromium:latest";
export const CONTAINER = "pithagoras-browser";
/** The name compose used, so an existing profile — and its logins — carries over. */
export const VOLUME = process.env.BROWSER_VOLUME || "pithagoras_browser-profile";

/** Where the browser's own web UI listens unless told otherwise: this machine. */
const LOOPBACK = "127.0.0.1";
/** The address a container was made to listen on, kept on it: Docker shows nothing of the web server's own configuration. */
const BIND_LABEL = "pithagoras.browser-bind";

export interface BrowserConfig {
  user: string;
  password: string;
  port: string;
  httpsPort: string;
}

/**
 * Settings first, environment second.
 *
 * The environment is how the compose version was configured, and a deployment
 * upgrading from it should not have to retype anything.
 */
export function config(): BrowserConfig {
  return {
    user: getSetting("browser_user") || process.env.BROWSER_USER || "agent",
    password: getSetting("browser_password") || process.env.BROWSER_PASSWORD || "",
    port: getSetting("browser_port") || process.env.BROWSER_PORT || "3010",
    httpsPort: getSetting("browser_https_port") || process.env.BROWSER_HTTPS_PORT || "3011",
  };
}

export function saveConfig(patch: Partial<BrowserConfig>): BrowserConfig {
  const map: Record<keyof BrowserConfig, string> = {
    user: "browser_user",
    password: "browser_password",
    port: "browser_port",
    httpsPort: "browser_https_port",
  };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v) putSetting(map[k as keyof BrowserConfig], v);
  }
  return config();
}

const badBinds = new Set<string>();

/**
 * The address the browser's web UI (3010 and 3011) listens on, from `BROWSER_BIND`.
 *
 * This machine only, unless an IPv4 address says otherwise: the container shares the host's network, so what
 * it listens on is the host's own interfaces, and the only thing in front of it is one password. `0.0.0.0` is
 * every interface, as it was before this could be chosen. Anything else is refused to the safe answer rather
 * than passed on, since it ends up in a shell script.
 */
export function uiBind(): string {
  const wanted = process.env.BROWSER_BIND?.trim();
  if (!wanted) return LOOPBACK;
  if (isIPv4(wanted)) return wanted;
  if (!badBinds.has(wanted)) {
    badBinds.add(wanted);
    console.warn(`[portal] BROWSER_BIND=${wanted} is not an IPv4 address, so the browser's UI stays on ${LOOPBACK}`);
  }
  return LOOPBACK;
}

const isLoopback = (address: string) => address.startsWith("127.");

/**
 * Can the browser's own web UI be reached from another machine, so that the page may link to it?
 *
 * `outdated` is a container made before its UI was held to an address: it listens on every interface whatever
 * `BROWSER_BIND` says now, until it is removed and installed again. A browser the portal does not run is not
 * one it knows the address of, so it keeps the link it always had.
 */
export async function uiState(): Promise<{ exposed: boolean; outdated: boolean }> {
  if (process.env.BROWSER_EXTERNAL === "true" || !dockerAvailable()) return { exposed: true, outdated: false };
  const found = await request<{ Config?: { Labels?: Record<string, string> } }>("GET", `/containers/${CONTAINER}/json`).catch(() => null);
  if (found?.status !== 200) return { exposed: !isLoopback(uiBind()), outdated: false };
  const bound = found.body?.Config?.Labels?.[BIND_LABEL];
  return { exposed: !isLoopback(bound ?? "0.0.0.0"), outdated: bound === undefined };
}

/** Progress of a pull in flight, so a multi-gigabyte download is not silence. */
let pulling: PullState = { active: false, line: "" };
export const pullState = () => pulling;

/**
 * Which of the two ways this deployment can run a browser.
 *
 * Docker first where it is available: a container costs nothing to anyone who
 * does not install it, and gives a real headful browser whatever the host looks
 * like. A local Chrome is the fallback for deployments with no socket, and uses
 * what is already on the machine rather than adding to the image.
 */
export async function status() {
  if (process.env.BROWSER_EXTERNAL === 'true') {
    let running = false;
    try {
      const response = await fetch(`${browserCdp()}/json/version`, {signal: AbortSignal.timeout(4000)});
      running = response.ok && typeof (await response.json() as {Browser?:string}).Browser === 'string';
    } catch { /* An externally managed browser can be stopped independently. */ }
    return {available:false, mode:'external' as const, image:true, container:running ? 'running' as const : 'stopped' as const, pulling};
  }
  if (!dockerAvailable()) {
    const l = local.status();
    return {
      available: l.available,
      mode: "local" as const,
      image: l.available,
      container: (l.running ? "running" : l.available ? "stopped" : "unavailable") as
        | "absent"
        | "stopped"
        | "running"
        | "unavailable",
      binary: l.binary,
      headless: l.headless,
      pulling,
    };
  }
  const [image, state] = await Promise.all([imagePresent(IMAGE), containerState(CONTAINER)]);
  return {
    available: true,
    mode: "docker" as const,
    image,
    container: (!state.exists ? "absent" : state.running ? "running" : "stopped") as
      | "absent"
      | "stopped"
      | "running",
    pulling,
  };
}

/**
 * Run before the image's own start, to keep its web server to one address.
 *
 * The image's nginx listens on every interface and has no setting for that, but it writes its configuration
 * from /defaults/default.conf each time it starts, so that is rewritten first: the IPv6 listens go, and the
 * IPv4 ones are given the address. The portal's own proxy reaches the server on 127.0.0.1, so any other address
 * gets a second listen there. The container ends here, loudly, if that did not take (an image that changed its
 * layout), rather than starting with the UI open to the network. `0.0.0.0` leaves the image as it is.
 *
 * That file lives in the container's writable layer, and a stopped container is started again as it is (Stop and
 * Start, a reboot), so the image's own copy is kept beside it once and every start begins from that. An edit
 * made on top of the last start's would put the address in twice and leave nginx with a config it refuses.
 */
const BIND_SCRIPT = String.raw`set -e
f=/defaults/default.conf
[ -e "$f.orig" ] || cp "$f" "$f.orig"
cp "$f.orig" "$f"
if [ "$PITHAGORAS_UI_BIND" != 0.0.0.0 ]; then
  listens="s/listen \([0-9]\)/listen $PITHAGORAS_UI_BIND:\1/"
  if [ "$PITHAGORAS_UI_BIND" != 127.0.0.1 ]; then
    listens="/listen [0-9]/{h;s/listen /listen 127.0.0.1:/;x;s/listen /listen $PITHAGORAS_UI_BIND:/;G;}"
  fi
  sed -i -e '/listen \[::\]:/d' -e "$listens" "$f"
  grep -qF "listen $PITHAGORAS_UI_BIND:" "$f" || { echo "pithagoras: the browser's UI could not be bound to $PITHAGORAS_UI_BIND" >&2; exit 1; }
fi
exec /init`;

/**
 * The container, as validated by hand before any of this was automated.
 *
 * seccomp:unconfined is chromium's own sandbox needing room; the alternative is
 * --no-sandbox, which is worse. Host networking is what puts the debugging port
 * on the same loopback as the portal without publishing it anywhere; the web UI
 * needs BIND_SCRIPT for that, since it listens on every interface by itself.
 */
function spec(cfg: BrowserConfig) {
  const bind = uiBind();
  return {
    Image: IMAGE,
    Entrypoint: ["/bin/sh", "-c", BIND_SCRIPT],
    Labels: { [BIND_LABEL]: bind },
    Env: [
      "PUID=0",
      "PGID=0",
      `TZ=${process.env.TZ || "Etc/UTC"}`,
      `CUSTOM_USER=${cfg.user}`,
      `PASSWORD=${cfg.password}`,
      `CUSTOM_PORT=${cfg.port}`,
      `CUSTOM_HTTPS_PORT=${cfg.httpsPort}`,
      `PITHAGORAS_UI_BIND=${bind}`,
      "CHROME_CLI=--remote-debugging-port=9222",
      // The image restarts the app when it exits; without this, closing the
      // window leaves a healthy container with no browser in it.
      "RESTART_APP=true",
    ],
    HostConfig: {
      NetworkMode: "host",
      SecurityOpt: ["seccomp=unconfined"],
      ShmSize: 1024 * 1024 * 1024,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: [`${VOLUME}:/config`],
    },
  };
}

export const ALREADY_INSTALLING = 'The browser is already being installed';

/** An install that is on its way: a second one would pull the same image and create the same container, or remove the first's. */
let installing = false;
export const installInFlight = () => installing;

export async function install(): Promise<void> {
  if (process.env.BROWSER_EXTERNAL === 'true') throw new Error('This browser is managed outside the portal');
  if (installing) throw new Error(ALREADY_INSTALLING);
  installing = true;
  try {
    await installNow();
  } finally {
    installing = false;
  }
}

async function installNow(): Promise<void> {
  // Nothing to install without Docker: the local runner uses a browser that is
  // already there, so installing is just starting it.
  if (!dockerAvailable()) return local.start();

  const cfg = config();
  if (!cfg.password) {
    // Refused rather than defaulted: an unauthenticated browser holding live
    // logins is the one outcome worth failing over.
    throw new Error("Set a password before installing — it guards a browser holding live logins");
  }

  await ensureImage(IMAGE, (state) => (pulling = state));

  await request("POST", `/volumes/create`, { Name: VOLUME });

  const existing = await containerState(CONTAINER);
  if (existing.exists) await remove();

  const created = await request<{ Id?: string; message?: string }>(
    "POST",
    `/containers/create?name=${CONTAINER}`,
    spec(cfg)
  );
  if (created.status >= 400) throw new Error(created.body?.message || `Create failed (${created.status})`);
  await start();
}

export async function start(): Promise<void> {
  if (process.env.BROWSER_EXTERNAL === 'true') throw new Error('This browser is managed outside the portal');
  if (!dockerAvailable()) return local.start();
  await containerAction(CONTAINER, "start");
}

export async function stop(): Promise<void> {
  if (process.env.BROWSER_EXTERNAL === 'true') throw new Error('This browser is managed outside the portal');
  if (!dockerAvailable()) return local.stop();
  await containerAction(CONTAINER, "stop");
}

/** Removes the container. The profile volume is left alone — that is the logins. */
export async function remove(): Promise<void> {
  if (process.env.BROWSER_EXTERNAL === 'true') throw new Error('This browser is managed outside the portal');
  if (!dockerAvailable()) return local.stop();
  await containerAction(CONTAINER, "remove");
}

/** Forgets the logins as well. Separate on purpose, and not undoable. */
export async function forgetProfile(): Promise<void> {
  if (process.env.BROWSER_EXTERNAL === 'true') throw new Error('This browser is managed outside the portal');
  await remove();
  const res = await request<{ message?: string }>("DELETE", `/volumes/${VOLUME}`);
  if (res.status >= 400 && res.status !== 404) {
    throw new Error(res.body?.message || `Could not remove the profile (${res.status})`);
  }
}

export const suggestPassword = () => randomBytes(12).toString("hex");
