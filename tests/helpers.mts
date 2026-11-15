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

/** What a theme must never carry into the page: a rule of CSS, a request, or a way out of its declaration. */
export const HOSTILE_TOKENS: [string, string][] = [
  ["radius-lg", "url(https://example.test/x.png)"], ["radius-lg", "expression(alert(1))"], ["radius-lg", "0.5rem; color: red"], ["radius-lg", "0.5rem} body{display:none"],
  ["radius-lg", "0.5rem !important"], ["radius-lg", "calc(1rem + 2rem)"], ["radius-lg", "var(--canvas)"], ["radius-lg", "\\30 .5rem"], ["radius-lg", "0.5rem/*"], ["radius-lg", "0.5rem\n}"],
  ["radius-lg", "-1rem"], ["radius-lg", "9rem"], ["radius-lg", "1e1rem"], ["radius-lg", "1"], ["radius-lg", "inherit"],
  ["pad", "5rem"], ["pad", "0"], ["text-base", "100px"], ["text-base", "0.1rem"], ["chat-max", "10000rem"], ["nav-width", "1px"],
  ["font-sans", "url(https://example.test/a.woff2)"], ["font-sans", "Inter; background: url(x)"], ["font-sans", "Inter, url(//example.test/a)"], ["font-sans", "x} body { display: none"],
  ["font-sans", "x/* "], ["font-sans", "@import 'https://example.test/x.css'"], ["font-sans", "expression(1)"], ["font-sans", "a\\;b"], ["font-sans", "a<script>"], ["font-sans", "a:b"],
  ["font-sans", "x".repeat(201)], ["font-sans", ""], ["font-mono", "a !important"], ["font-mono", "var(--font-sans)"],
  // A stack the browser cannot read leaves the page in its default serif: an empty name, a lone hyphen, a quote in a quote.
  ["font-sans", ",,"], ["font-sans", "Inter,"], ["font-sans", "-"], ["font-sans", '"a""b"'], ["font-sans", "."], ["font-sans", "1Font"], ["font-mono", '"Fira, Code"'],
  ["shadow-pop", "0 0 0 999px rgb(0 0 0)"], ["shadow-pop", "inset 0 4rem 0 4rem #fff"], ["shadow-sm", "inset 0 1px 0 #ffffff1a"], ["shadow-pop", "0 1px 2px url(https://example.test/x)"], ["shadow-pop", "0 1px 2px rgb(var(--fg))"], ["shadow-pop", "0 1px 2px rgb(0 0 0); color: red"],
  ["shadow-sm", "0 1px 2px rgb(300 0 0)"], ["shadow-sm", "1px"], ["shadow-sm", "0 1px 2px red"], ["shadow-sm", "0 1px 2px rgb(0 0 0 / 0.5)} body{display:none"], ["shadow-sm", "a, b, c, d, e"],
  ["dur-fast", "2s"], ["dur-fast", "-1ms"], ["dur-base", "fast"], ["dur-base", "calc(1s)"],
  ["ease-out", "steps(4)"], ["ease-out", "cubic-bezier(2, 1, .36, 1)"], ["ease-out", "cubic-bezier(., 1, .36, 1)"], ["ease-spring", "var(--ease-out)"], ["ease-spring", "linear(0, 1)"],
  ["border-width", "5px"], ["border-width", "thin"],
  ["z-confirm", "1"], ["z-dialog", "99999"], ["font-mono-chat", "Inter"], ["color", "red"], ["background", "url(x)"], ["--radius-lg", "1rem"], ["__proto__", "1rem"], ["constructor", "1rem"],
];
