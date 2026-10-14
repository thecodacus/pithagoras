import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inProcessHome, scratch } from './server-harness.mjs';
// sdk-client reaches the session manager, and so the database: never the one
// of a portal this suite happens to be run from.
const data = inProcessHome('ctx-data-');
const { extraContextFiles } = await import('../dist/pi/sdk-client.js');

const names = (files) => files.map((f) => path.basename(f.path)).sort();

// Home is the agent's own directory: its identity and memory are in the folder the chat works in.
// A project is any other folder, and has only what is in it — its AGENTS.md, which pi finds by itself.
test('a chat in the agent home gets SOUL, PrimaryUser and MEMORY; one in a project gets none of them', () => {
  const base = scratch('ctx-');
  const home = path.join(base, 'agent-home');
  const project = path.join(base, 'workspaces', 'cool-project');
  mkdirSync(home); mkdirSync(project, { recursive: true });
  for (const f of ['SOUL.md', 'PrimaryUser.md', 'MEMORY.md', 'TEAM.md']) writeFileSync(path.join(home, f), `# ${f}`);
  writeFileSync(path.join(project, 'AGENTS.md'), 'Answer in German.');

  assert.deepEqual(names(extraContextFiles(home, 'primary')), ['MEMORY.md', 'PrimaryUser.md', 'SOUL.md']);
  // What a task chat is created with: the role column defaults to primary.
  assert.deepEqual(names(extraContextFiles(home)), ['MEMORY.md', 'PrimaryUser.md', 'SOUL.md']);
  // The project's own file is not one of the agent's; pi discovers AGENTS.md itself.
  assert.deepEqual(extraContextFiles(project, 'primary'), []);
  // Someone who is not the owner still never gets the private half.
  assert.deepEqual(names(extraContextFiles(home, 'guest')), ['SOUL.md', 'TEAM.md']);
});
