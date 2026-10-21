import { randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import type { PullState } from "../../../docker/src/api";
import { browserVersion } from "./cdp";
import { docker, portal } from "./host";
import * as local from "./local";
import { putSettings, setting, type Settings } from "./store";

/**
 * The agent's browser, as something the portal installs rather than something
 * every deployment carries.
 *
 * It used to be a service in docker-compose.yml, which meant everyone who never
 * wanted a browser still had it in their file, still had to know why it was
 * there, and — for a while — could not start the portal without setting its
 * password. Installed from the UI instead: nothing exists until somebody asks,
 * and removing it leaves no trace but the profile.
 *
 * Docker runs the container (`pithagoras-docker`, which Browser requires), and what Browser may do with it is what
 * Docker lets any extension do with its own. The container and the profile volume the portal made before Browser was
 * an extension carry no extension's name, and are taken over by their names (`adoptKept`, and again before Browser acts
 * on them), never made again.
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
    user: setting("user") || process.env.BROWSER_USER || "agent",
    password: setting("password") || process.env.BROWSER_PASSWORD || "",
    port: setting("port") || process.env.BROWSER_PORT || "3010",
    httpsPort: setting("httpsPort") || process.env.BROWSER_HTTPS_PORT || "3011",
  };
}

export function saveConfig(patch: Partial<BrowserConfig>): BrowserConfig {
  const said: Settings = {};
  for (const k of ["user", "password", "port", "httpsPort"] as const) {
    const v = patch[k];
    if (typeof v === "string" && v) said[k] = v;
  }
  putSettings(said);
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
    portal().log(`BROWSER_BIND=${wanted} is not an IPv4 address, so the browser's UI stays on ${LOOPBACK}`);
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
  if (process.env.BROWSER_EXTERNAL === "true" || !(await docker().available())) return { exposed: true, outdated: false };
  const found = await docker().containers.get(CONTAINER).catch(() => undefined);
  if (!found) return { exposed: !isLoopback(uiBind()), outdated: false };
  const bound = found.labels[BIND_LABEL];
  return { exposed: !isLoopback(bound ?? "0.0.0.0"), outdated: bound === undefined };
}

/** Progress of a pull in flight, so a multi-gigabyte download is not silence. */
let pulling: PullState = { active: false, line: "" };

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
    // An externally managed browser can be stopped independently.
    const running = (await browserVersion()) !== null;
    return {available:false, mode:'external' as const, image:true, container:running ? 'running' as const : 'stopped' as const, pulling};
  }
  if (!(await docker().available())) {
    const l = await local.status();
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
  const [image, found] = await Promise.all([docker().images.present(IMAGE), docker().containers.get(CONTAINER)]);
  return {
    available: true,
    mode: "docker" as const,
    image,
    container: (!found ? "absent" : found.state === "running" ? "running" : "stopped") as
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

/** Refused for a browser the portal does not run (`BROWSER_EXTERNAL=true`): it is started, stopped and removed where it runs. */
function managedHere(): void {
  if (process.env.BROWSER_EXTERNAL === 'true') throw new Error('This browser is managed outside the portal');
}

/** Docker's answer that there is no such container or volume, which is no failure where nothing has to be there. */
function absent(e: unknown): void {
  if ((e as { status?: number }).status !== 404) throw e;
}

export async function install(): Promise<void> {
  managedHere();
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
  if (!(await docker().available())) return local.start();

  const cfg = config();
  if (!cfg.password) {
    // Refused rather than defaulted: an unauthenticated browser holding live
    // logins is the one outcome worth failing over.
    throw new Error("Set a password before installing — it guards a browser holding live logins");
  }

  const d = docker();
  await d.images.ensure(IMAGE, (state) => (pulling = state));

  // The profile the portal made before, or compose before it, is taken over rather than made anew: it holds the logins.
  await d.volumes.adopt(VOLUME).catch(async (e) => {
    absent(e);
    await d.volumes.create(VOLUME);
  });
  // And a container made before, so that it can be replaced: Docker replaces only what is Browser's.
  await d.containers.adopt(CONTAINER).catch(absent);
  await d.containers.create(CONTAINER, spec(cfg));
  await d.containers.start(CONTAINER);
}

/**
 * Docker's containers, with the browser's taken over first, as an install does: one made before Browser was an
 * extension is taken over as the half starts, but not where Docker could not be reached then and can now.
 */
async function containers() {
  const d = docker();
  await d.containers.adopt(CONTAINER).catch(absent);
  return d.containers;
}

export async function start(): Promise<void> {
  managedHere();
  if (!(await docker().available())) return local.start();
  await (await containers()).start(CONTAINER);
}

export async function stop(): Promise<void> {
  managedHere();
  if (!(await docker().available())) return local.stop();
  await (await containers()).stop(CONTAINER);
}

/** Removes the container. The profile volume is left alone — that is the logins. */
export async function remove(): Promise<void> {
  managedHere();
  if (!(await docker().available())) return local.stop();
  await (await containers()).remove(CONTAINER);
}

/** Forgets the logins as well. Separate on purpose, and not undoable. A local Chrome's profile is kept: this is the container's. */
export async function forgetProfile(): Promise<void> {
  managedHere();
  if (!(await docker().available())) return local.stop();
  await (await containers()).remove(CONTAINER);
  // Taken over first, as the container is; one that is gone already is gone.
  await docker().volumes.adopt(VOLUME).catch(absent);
  await docker().volumes.remove(VOLUME);
}

/**
 * Takes over the container and the profile volume the portal made before Browser was an extension, by their names, so
 * that Browser may start, stop and remove them as its own: as the half starts, every time, so that a record of them
 * Docker lost is made again. Nothing is made, made again or started: a container made before goes on as it is, until
 * somebody removes it and installs again. One that is not there is not taken over, and one that is another
 * extension's is not Browser's to take, which the portal's log says.
 */
export async function adoptKept(): Promise<void> {
  const d = docker();
  if (!(await d.available())) return;
  const take = (what: string, adopt: () => Promise<unknown>) =>
    adopt().catch((e) => {
      if ((e as { status?: number }).status !== 404) portal().log(`could not take over ${what}: ${(e as Error).message}`);
    });
  await take(`the browser's profile, the volume ${VOLUME}`, () => d.volumes.adopt(VOLUME));
  await take(`the browser's container ${CONTAINER}`, () => d.containers.adopt(CONTAINER));
}

export const suggestPassword = () => randomBytes(12).toString("hex");
