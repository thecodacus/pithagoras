import { status } from "./browser-service.js";

/**
 * Somebody has to be watching, or the browser stops rendering.
 *
 * The image composites with labwc and streams with selkies, and selkies stops
 * the capture loop when the last viewer disconnects. With nothing consuming
 * frames the compositor stops presenting, so Chrome gets no BeginFrames — and
 * every Playwright action that waits for an element to be "visible, enabled and
 * stable" waits for a frame that never comes. Clicking, typing, filling a form
 * and screenshotting all timed out; navigating and reading the page carried on
 * working, because those need no frames. The agent's browser worked only while
 * a human happened to have the panel open.
 *
 * So the portal watches it when nobody else is. The stream is damage-based, so
 * a still page costs almost nothing to encode.
 */

/** selkies' own websocket, reachable directly because the container shares the host's network. */
const STREAM_PORT = process.env.BROWSER_STREAM_PORT || "8082";

/**
 * Low, because these frames are thrown away. Playwright needs two consecutive
 * frames with the same bounding box, not a smooth picture.
 */
const FRAMERATE = 10;

const POLL_MS = 15_000;
/** After being displaced, long enough not to fight over the display. */
const BACKOFF_MS = 60_000;

let socket: WebSocket | undefined;
let viewers = 0;
let timer: NodeJS.Timeout | undefined;
let backoffUntil = 0;

/**
 * A real viewer arrived or left.
 *
 * Only one client may own the primary display — a second one takes it and the
 * first is killed. So the portal's own stream stands down for as long as
 * somebody is actually looking, and picks up again when they leave.
 */
export function viewerConnected(): void {
  viewers++;
  disconnect();
}

export function viewerDisconnected(): void {
  viewers = Math.max(0, viewers - 1);
}

function disconnect(): void {
  const open = socket;
  socket = undefined;
  try {
    open?.close();
  } catch {
    // Already gone.
  }
}

function connect(): void {
  const ws = new WebSocket(`ws://127.0.0.1:${STREAM_PORT}/websocket`);
  socket = ws;
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    // Claiming the primary display is what makes selkies capture at all; a
    // client that never says which display it is watching is treated as a
    // bystander and the capture loop stays stopped. No resolution is sent
    // with it, so the desktop a person set up is left as it is.
    ws.send(`SETTINGS,${JSON.stringify({ displayId: "primary", framerate: FRAMERATE })}`);
    setTimeout(() => {
      if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send("START_VIDEO");
    }, 500);
  };

  ws.onmessage = (event) => {
    // KILL means a real viewer took the display. Stay away for a while rather
    // than reconnecting into a fight over it.
    if (typeof event.data === "string" && event.data.startsWith("KILL")) {
      backoffUntil = Date.now() + BACKOFF_MS;
      disconnect();
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = undefined;
  };
  ws.onerror = () => {
    if (socket === ws) socket = undefined;
  };
}

async function tick(): Promise<void> {
  if (socket) return;
  if (viewers > 0 || Date.now() < backoffUntil) return;
  // Only the container runtime needs this. A local Chrome is presented by a
  // real desktop, which never stops drawing.
  const state = await status();
  if (state.mode === "local" || state.container !== "running") return;
  try {
    connect();
  } catch {
    // The container may be on its way up. The next tick tries again.
  }
}

/** Started once, with the portal. Does nothing until the browser is installed. */
export function watchBrowserFrames(): void {
  if (timer) return;
  timer = setInterval(() => void tick().catch(() => {}), POLL_MS);
  timer.unref();
  void tick().catch(() => {});
}
