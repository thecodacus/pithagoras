import type { Server } from "node:http";

/**
 * Ends the connections of a server that is closing: the idle ones at once, the rest after `graceMs`. A request that is
 * being answered when the portal stops can finish in that time; an event stream, which never finishes by itself, is
 * cut then. (`closeAllConnections` alone cut the answers as well.)
 */
export function closeConnections(server: Server, graceMs: number): void {
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), graceMs).unref();
}
