import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/** Kept for as long as this server runs: closed, it lets the next one in. */
let held: net.Server | undefined;

const listen = (server: net.Server, address: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });

/** Whether a server is listening there, rather than a socket left by one that ended. */
const answered = (address: string) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(address);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/**
 * Makes this the one server on a data directory, or says it is not.
 *
 * A second server on the same data marks every chat the first has running as
 * interrupted when it starts, and nothing about the port stops that: one the
 * agent starts from a chat with another PORT reads the same database. So the
 * data itself is held, by listening on a socket in it. The system lets go of
 * it when the process ends however it ends, and nothing done in the process
 * can: a lock on a file, as SQLite takes, was dropped the moment anything here
 * opened and closed that file once, pi's read tool included.
 *
 * A socket left by a server that ended answers nobody, and is replaced. Where
 * no socket can be made in the directory — a path too long for one, a file
 * system that has none — one named after the directory stands in, outside it.
 *
 * The directory is closed to everyone but its owner, on every start, one made
 * by an older version or by hand too: portal.db holds the channels' bot tokens,
 * the add-ons' passwords and every conversation, and with the usual umask the
 * folder, the database and its backups would be readable by every account on
 * the machine.
 */
export async function holdDataDir(dir: string): Promise<boolean> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (e) {
    // A folder that is somebody else's, or on a file system without modes: the portal runs, and says so.
    console.warn(`[portal] could not restrict ${dir} to its owner: ${(e as Error).message}`);
  }
  const real = realpathSync(dir);
  const file = path.join(real, "portal.sock");
  const named = `\0pithagoras-${createHash("sha256").update(real).digest("hex").slice(0, 32)}`;
  // 108 bytes on Linux, the ending NUL included.
  const places = Buffer.byteLength(file) < 108 ? [file, named] : [named];
  let failed: Error | undefined;
  for (const address of places) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const server = net.createServer((socket) => socket.destroy());
      try {
        await listen(server, address);
        server.unref();
        held = server;
        return true;
      } catch (e) {
        failed = e as Error;
        // No socket here at all: the next place.
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
        if (await answered(address)) return false;
        // Taken again after the old one was cleared, or taken and silent: not
        // somewhere else instead, where a second server could start beside it.
        if (address !== file || attempt > 0) throw e;
        try {
          unlinkSync(file);
        } catch {
          // Gone already: another server starting now took it, or will.
        }
      }
    }
  }
  throw failed ?? new Error("no socket could be made");
}
