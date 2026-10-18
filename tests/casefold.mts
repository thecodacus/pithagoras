import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A folder on a case-insensitive file system, for a test of what a name that differs from another only in capitals (or in the form of a
 * letter) does there: a tmpfs mounted with `casefold`, which a test cannot mount itself (it is root's to do), so the tests that need it are
 * run again in a mount namespace of their own where the user is root (`unshare -rm`), with the folder named in PITHAGORAS_CASEFOLD_DIR.
 * It needs user namespaces, a kernel from 6.13 on (tmpfs has `casefold` since) and `chattr`; where one of them is missing the tests are skipped.
 */
export const CASEFOLD: string | null = process.env.PITHAGORAS_CASEFOLD_DIR ?? null;

/**
 * Runs the tests of `file` whose names match `pattern` once more with PITHAGORAS_CASEFOLD_DIR set, and says how it went (`ok`, and what the
 * run printed); null where the file system cannot be made here (see CASEFOLD).
 */
export function inCasefold(file: string, pattern: string): { ok: boolean; output: string } | null {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'casefold-'));
  const script = [
    'set -e',
    'mkdir -p "$ROOT/mnt"',
    'mount -t tmpfs -o casefold=utf8-12.1.0 tmpfs "$ROOT/mnt"',
    'mkdir "$ROOT/mnt/d"',
    'chattr +F "$ROOT/mnt/d"',
    'export PITHAGORAS_CASEFOLD_DIR="$ROOT/mnt/d"',
    '[ "$1" = probe ] && exit 0',
    'exec "$0" --import tsx --test --test-name-pattern="$2" "$3"',
  ].join('\n');
  // Not the test runner's own marker: the child is a run of its own, and would take itself for a part of this one.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const run = (mode: string) => spawnSync('unshare', ['-rm', 'sh', '-c', script, process.execPath, mode, pattern, file], { env: { ...env, ROOT: root }, encoding: 'utf8', timeout: 120_000 });
  try {
    if (run('probe').status !== 0) return null;
    const done = run('run');
    return { ok: done.status === 0, output: `${done.stdout}\n${done.stderr}`.slice(-6000) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
