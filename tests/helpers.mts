// The helpers that the server's tests have, for the tests in this folder: a home of its own for a test that loads
// modules into its own process, a scratch folder that is removed when the tests end, and the free port and the home
// of a test that starts the server.
export { inProcessHome, scratch, testHome, freePort } from "../core/server/test/server-harness.mjs";

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

/**
 * Runs `work`, and gives each file it put in place with a rename, by where it went, and whether what was renamed had
 * been forced to disk (fsync) before. A file renamed before its bytes are on disk can be empty after a crash, though
 * its name is there.
 */
export function renamesOnDisk(work: () => void): { to: string; synced: boolean }[] {
  const { openSync, fsyncSync, renameSync } = fs;
  const opened = new Map<number, string>();
  const synced = new Set<string>();
  const renamed: { to: string; synced: boolean }[] = [];
  const mocks = [
    mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
      const fd = openSync(...args);
      opened.set(fd, String(args[0]));
      return fd;
    }),
    mock.method(fs, "fsyncSync", (fd: number) => {
      fsyncSync(fd);
      synced.add(opened.get(fd)!);
    }),
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      renameSync(from, to);
      renamed.push({ to: String(to), synced: synced.has(String(from)) });
    }),
  ];
  // What a module imported by name from node:fs follows too.
  syncBuiltinESMExports();
  try {
    work();
  } finally {
    for (const method of mocks) method.mock.restore();
    syncBuiltinESMExports();
  }
  return renamed;
}
