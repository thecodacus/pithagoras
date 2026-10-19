import { spawn } from 'node:child_process';
import { chmodSync, chownSync, closeSync, constants, existsSync, mkdirSync, openSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scratch } from './server-harness.mjs';

/**
 * A race, for the tests of what the portal does in a folder as root (removeFile and renameFile of core, removeDocument and renameDocument of
 * Documents): an agent that is not root moves a folder it has no access to (root's, mode 0700) onto the place of the documents folder and back
 * again, as often as it can, while the caller deletes or renames a file called doc.md in "the documents folder". A move within a folder needs
 * only the right to write in that folder, so the agent can do it to a folder it cannot enter; what the portal does in it, it does with its own
 * rights. Only as root: where the portal is not root there is nothing to cross.
 */
export const root = process.getuid?.() === 0;
export const AGENT = 10102;
const MS = 2500;

/** The agent: swaps `documents` and `private` in `work` for `ms`, then says how many rounds it made. */
const RACER = `
const fs = require('node:fs');
const work = process.argv[1];
const d = work + '/documents', p = work + '/private', x = work + '/documents.x';
const end = Date.now() + Number(process.argv[2]);
let rounds = 0;
while (Date.now() < end) {
  try { fs.renameSync(d, x); fs.renameSync(p, d); } catch {}
  try { fs.renameSync(d, p); fs.renameSync(x, d); } catch {}
  rounds++;
}
console.log(rounds);
`;

/**
 * Runs `act(folder, options)` in a loop against the racer for MS, where `folder` is the documents folder's path and `options` are
 * `{ direct, alone }` and, with `expect`, `expect: { dev, ino }` of that folder; with `likeParent`, `likeParent: true`. Returns how often the folder the agent cannot enter was acted in,
 * how many calls were made and how many rounds the agent moved the folders; null where the agent's user cannot run node here (it moved nothing).
 */
export async function race(act, { expect = false, likeParent = false } = {}) {
  const top = scratch('wsfiles-race-');
  chmodSync(top, 0o755);
  const work = path.join(top, 'work');
  const real = path.join(work, 'documents');
  const closed = path.join(work, 'private');
  mkdirSync(work);
  mkdirSync(real);
  mkdirSync(closed, { mode: 0o700 });
  chmodSync(closed, 0o700);
  chownSync(work, AGENT, AGENT);
  chownSync(real, AGENT, AGENT);
  chmodSync(work, 0o755);
  chmodSync(real, 0o755);
  // The two folders are kept by descriptors, so that each can be looked into whatever its name is at the moment.
  const fdReal = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY);
  const fdClosed = openSync(closed, constants.O_RDONLY | constants.O_DIRECTORY);
  const inReal = (name) => `/proc/self/fd/${fdReal}/${name}`;
  const inClosed = (name) => `/proc/self/fd/${fdClosed}/${name}`;
  const id = statSync(real, { bigint: true });
  const options = { direct: true, alone: true, ...(likeParent ? { likeParent: true, chats: ['a'] } : {}), ...(expect ? { expect: { dev: id.dev, ino: id.ino } } : {}) };
  let racer;
  let rounds = '';
  try {
    racer = spawn(process.execPath, ['-e', RACER, work, String(MS)], { uid: AGENT, gid: AGENT, cwd: '/', stdio: ['ignore', 'pipe', 'ignore'] });
    racer.stdout.on('data', (chunk) => (rounds += chunk));
    const spawned = await new Promise((resolve) => {
      racer.once('spawn', () => resolve(true));
      racer.once('error', () => resolve(false));
    });
    if (!spawned) return null;
    const stopped = new Promise((resolve) => racer.once('close', resolve));
    let breaches = 0;
    let calls = 0;
    const end = Date.now() + MS;
    while (Date.now() < end) {
      // The file of that name in each folder, as the portal finds the folders: the documents folder's own (the agent's), and the closed one's.
      if (!existsSync(inReal('doc.md'))) {
        writeFileSync(inReal('doc.md'), 'ours');
        chownSync(inReal('doc.md'), AGENT, AGENT);
      }
      if (!existsSync(inClosed('doc.md'))) writeFileSync(inClosed('doc.md'), 'theirs');
      calls++;
      try {
        act(real, options);
      } catch {
        // Refused, or the folder was not there at the moment: no matter. What counts is what became of the closed folder.
      }
      // The closed folder's file is gone (removed, or renamed): it was acted in.
      if (!existsSync(inClosed('doc.md'))) breaches++;
      if (existsSync(inClosed('new.md'))) unlinkSync(inClosed('new.md'));
      if (existsSync(inReal('new.md'))) unlinkSync(inReal('new.md'));
    }
    await stopped;
    // An agent that could not run (node is not for its user to read, say) moved nothing: the race did not happen.
    if (!Number(rounds.trim() || 0)) return null;
    return { breaches, calls, rounds: Number(rounds.trim()) };
  } finally {
    racer?.kill();
    closeSync(fdReal);
    closeSync(fdClosed);
    rmSync(top, { recursive: true, force: true });
  }
}

