import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import type { Request, Response } from "express";
import { config } from "./service";
import { viewerConnected, viewerDisconnected } from "./frames";

/**
 * The agent's browser, served through the portal.
 *
 * Two reasons this is a proxy rather than a link to port 3011:
 *
 * The VNC client refuses to run outside a secure context, and a secure context
 * needs every ancestor to be trustworthy — so an HTTPS iframe inside the portal
 * is only secure if the portal itself is. Same-origin means it inherits
 * whatever the portal has instead of needing its own.
 *
 * And it removes a second credential and a second certificate: the portal
 * decides who you are, so it holds the browser's password rather than asking
 * you for it again. That only holds if it decides before it proxies: both
 * halves are under /api/x, which the portal answers only with its login, since
 * the browser's own password is added on the way and its container would never ask.
 *
 * It is at /api/x/pithagoras-browser/ui/, with the slash: the browser's page
 * loads what it needs (./assets/…) and opens its stream from where it is.
 */

const UPSTREAM_HOST = process.env.BROWSER_HOST || "127.0.0.1";
const upstreamPort = () => Number(config().httpsPort);
/** Where in Browser's routes the browser's UI is, its page and its streams. */
const UI = /^\/ui(?=$|[/?])/i;

const auth = () => {
  const { user, password } = config();
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
};

/** Self-signed upstream on loopback: verifying it would mean pinning our own cert. */
const agent = new https.Agent({ rejectUnauthorized: false });

/** Where on the browser's own server an address under /ui is. */
function upstreamPath(url: string): string {
  const rest = url.replace(UI, "");
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * What goes on to the browser: the request as it came, without the portal's own
 * login cookie or anything the client sent as a credential. The container is
 * not the portal, and whatever runs in it must not be handed a way in.
 */
function forwarded(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const { cookie: _cookie, authorization: _authorization, ...rest } = headers;
  return { ...rest, host: `${UPSTREAM_HOST}:${upstreamPort()}`, authorization: auth() };
}

const FRAME_ANCESTORS = "frame-ancestors 'self'";

/**
 * What the browser UI answers, plus the one thing it does not say for itself:
 * only the portal's own pages may frame it. Added to a policy of its own as a
 * second one, so that both apply.
 */
function answered(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const own = headers["content-security-policy"];
  return { ...headers, "content-security-policy": own ? `${own}, ${FRAME_ANCESTORS}` : FRAME_ANCESTORS };
}

/** The route half, for every method under /ui (`portal.router.use("/ui", …)`). */
export function proxyUi(req: Request, res: Response): void {
  const proxied = https.request(
    {
      host: UPSTREAM_HOST,
      port: upstreamPort(),
      // Express strips the mount path from req.url, so it is already relative.
      path: req.url || "/",
      method: req.method,
      headers: forwarded(req.headers),
      agent,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, answered(upstream.headers));
      upstream.pipe(res);
    }
  );
  proxied.on("error", (e) => {
    if (!res.headersSent) res.status(502);
    res.end(`The browser is not answering: ${e.message}`);
  });
  req.pipe(proxied);
}

/**
 * An answer to a connection that is not going to become a stream, then closed.
 * Not left open for the client to close: one that never does would hold the
 * portal's end, and a descriptor, for as long as the portal runs.
 */
function refuse(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const giveUp = setTimeout(() => socket.destroy(), 5_000);
  giveUp.unref();
  socket.once("close", () => clearTimeout(giveUp));
}

/**
 * The stream half (`portal.http.upgrade`), handed a stream under Browser's
 * routes once its login and the page it comes from have been checked. Express
 * never sees an upgrade, so without this the page loads and then sits blank.
 * Only the streams under /ui are the browser's.
 */
export function uiUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!UI.test(req.url ?? "")) return refuse(socket, 404, "Not Found");
  const proxied = https.request({
    host: UPSTREAM_HOST,
    port: upstreamPort(),
    path: upstreamPath(req.url!),
    method: "GET",
    headers: forwarded(req.headers),
    agent,
  });
  proxied.end();
  // A visitor who leaves during the handshake takes the request with them.
  socket.once("close", () => proxied.destroy());
  socket.on("error", () => socket.destroy());

  proxied.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    if (socket.destroyed) return void upstreamSocket.destroy();
    const lines = Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
    // Each side's first bytes go back where they were read: the container's
    // into its own stream, which is sent on to the visitor, and the visitor's
    // into theirs, which is sent on to the container.
    if (upstreamHead?.length) upstreamSocket.unshift(upstreamHead);
    if (head?.length) socket.unshift(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
    // Somebody is watching now, so the portal's own stream gets out of the
    // way — only one client may hold the display, and the newer one wins.
    viewerConnected();
    let counted = true;
    const close = () => {
      if (counted) {
        counted = false;
        viewerDisconnected();
      }
      upstreamSocket.destroy();
      socket.destroy();
    };
    socket.on("close", close);
    upstreamSocket.on("close", close);
    socket.on("error", close);
    upstreamSocket.on("error", close);
  });
  // An answer that is not an upgrade — the container's password changed, it is
  // not up yet — said to the visitor instead of leaving them waiting.
  proxied.on("response", (answer) => {
    refuse(socket, answer.statusCode ?? 502, answer.statusMessage ?? "Bad Gateway");
    answer.resume();
  });
  proxied.on("error", () => socket.destroy());
}
