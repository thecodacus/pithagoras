import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import type { Express } from "express";
import { isAuthedUpgrade, requireAuth } from "./auth.js";
import { extensionUpgrade, isExtensionUrl } from "./extension-host.js";
import { watchStream } from "./login-streams.js";
import { config } from "./extensions/browser-service.js";
import { viewerConnected, viewerDisconnected } from "./extensions/browser-frames.js";

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
 * halves refuse what carries no login, since the browser's own password is
 * added on the way and its container would never ask.
 */

const UPSTREAM_HOST = process.env.BROWSER_HOST || "127.0.0.1";
const upstreamPort = () => Number(config().httpsPort);
const PREFIX = "/browser-ui";

const auth = () => {
  const { user, password } = config();
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
};

/** Self-signed upstream on loopback: verifying it would mean pinning our own cert. */
const agent = new https.Agent({ rejectUnauthorized: false });

/** Where on the browser's own server an address of the portal's /browser-ui is. */
function upstreamPath(url: string): string {
  const rest = url.slice(PREFIX.length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** Is `url` the browser's, however the prefix is cased — as Express matches the route? */
function isBrowserUrl(url: string | undefined): url is string {
  if (url === undefined || url.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return false;
  const next = url[PREFIX.length];
  return next === undefined || next === "/" || next === "?";
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
 * The route half. Registered with the other routes, before the SPA fallback —
 * that fallback answers everything outside /api, so a proxy mounted after it
 * quietly served the portal's own index.html instead.
 */
export function mountBrowserProxy(app: Express): void {
  app.use(PREFIX, requireAuth, (req, res) => {
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
  });

}

/**
 * The stream half, which needs the server rather than the app. Express never
 * sees an upgrade, so without this the page loads and then sits blank.
 */
export function attachBrowserUpgrade(server: http.Server): void {
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // With a listener here Node leaves every upgrade to it — no parser, no
    // timeout, no answer — so one that is not the browser's is answered too, and
    // a client that resets the connection is not an error nobody listens to.
    socket.on("error", () => {});
    // Express never sees an upgrade, so requireAuth did not either: the same
    // login, asked here. And a page of another site may not open the stream with
    // the visitor's cookie — a browser names where the page came from.
    const allowed = () => {
      if (!isAuthedUpgrade(req)) return refuse(socket, 401, "Unauthorized"), false;
      if (req.headers.origin && !fromHere(req.headers.origin, req.headers)) return refuse(socket, 403, "Forbidden"), false;
      // The stream is checked only as it opens: it ends when the password it was opened under goes.
      socket.once("close", watchStream(() => socket.destroy()));
      return true;
    };
    // An extension's server half may take upgrades under its own routes: checked the same way, then its to
    // answer. The login is asked first: without it, nothing is said of which extensions there are.
    if (isExtensionUrl(req.url)) {
      if (!allowed()) return;
      const extension = extensionUpgrade(req.url);
      return extension ? extension(req, socket, head) : refuse(socket, 404, "Not Found");
    }
    if (!isBrowserUrl(req.url)) return refuse(socket, 404, "Not Found");
    if (!allowed()) return;
    const proxied = https.request({
      host: UPSTREAM_HOST,
      port: upstreamPort(),
      path: upstreamPath(req.url),
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
  });
}

/**
 * Is `origin` a page of the host the request was made to? Behind a reverse proxy
 * that rewrites Host, that is the one the proxy was asked for, which it passes
 * on as X-Forwarded-Host. A browser cannot set that header on a stream it opens
 * from a page, so a page of another site cannot make itself the host this way.
 */
function fromHere(origin: string, headers: http.IncomingHttpHeaders): boolean {
  const forwarded = headers["x-forwarded-host"];
  // Several proxies in a row list the hosts they were asked for; the first is the visitor's.
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return [headers.host, first].some((host) => host && sameHost(origin, host));
}

/** Is `origin` the page of `host`, an address with or without the port its scheme implies? */
function sameHost(origin: string, host: string): boolean {
  // Only an address: anything URL would read as a user name or a path is not one.
  if (!/^[^\s/@?#\\]+$/.test(host)) return false;
  try {
    const { protocol, host: page } = new URL(origin);
    return new URL(`${protocol}//${host}`).host === page;
  } catch {
    return false;
  }
}
