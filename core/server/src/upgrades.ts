import type http from "node:http";
import type { Duplex } from "node:stream";
import { isAuthedUpgrade } from "./auth.js";
import { extensionUpgrade, isExtensionUrl } from "./extension-host.js";
import { watchStream } from "./login-streams.js";

/**
 * The server's WebSocket upgrades, every one of them. Express never sees an
 * upgrade, so without a listener here a page that opens a stream loads and
 * then sits blank, and requireAuth never asks for the login either.
 *
 * So the login is asked here, and where the page that opens the stream comes
 * from, once for every stream; then it is handed to what takes it: an
 * extension's server half under its own routes (/api/x/<package>/…). Anything
 * else is answered and closed.
 */
export function attachUpgrades(server: http.Server): void {
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // With a listener here Node leaves every upgrade to it — no parser, no
    // timeout, no answer — so one that nothing takes is answered too, and a
    // client that resets the connection is not an error nobody listens to.
    socket.on("error", () => {});
    // An extension's server half may take upgrades under its own routes, once the same login as requireAuth asks
    // is there: without it, nothing is said of which extensions there are. And a page of another site may not
    // open the stream with the visitor's cookie — a browser names where the page came from.
    if (!isExtensionUrl(req.url)) return refuse(socket, 404, "Not Found");
    if (!isAuthedUpgrade(req)) return refuse(socket, 401, "Unauthorized");
    if (req.headers.origin && !fromHere(req.headers.origin, req.headers)) return refuse(socket, 403, "Forbidden");
    // The stream is checked only as it opens: it ends when the password it was opened under goes.
    socket.once("close", watchStream(() => socket.destroy()));
    const extension = extensionUpgrade(req.url);
    return extension ? extension(req, socket, head) : refuse(socket, 404, "Not Found");
  });
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
