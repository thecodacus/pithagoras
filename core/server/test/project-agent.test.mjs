import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inProcessHome } from './server-harness.mjs';

// What a project that works with an agent carries into its chats, and when: the agent's soul, its primary
// user and its memory, read from the agent's home, with the memory an extension holds taking MEMORY.md's place
// unless the project does without it. In-process, so the files are those a chat would be handed.
inProcessHome('project-agent-');
const { extraContextFiles } = await import('../dist/pi/sdk-client.js');
const { agentFor, agentLinkedAt, linkedAgent, memoryHeldAt } = await import('../dist/project-agent.js');
const { holdMemory } = await import('../dist/memory-holder.js');
const { createAgent, deleteAgent, defaultAgent } = await import('../dist/agents.js');
const { projectAgent, projectAgents, releaseProjectsOf, setProjectAgent, clearProjectAgent } = await import('../dist/db.js');

const root = process.env.WORKSPACE_ROOT;

/** An extension that holds the agent's memory (`portal.memory.hold`), while `held` says it does. */
let held = false;
holdMemory('keeper', { label: 'Keeper', rule: "Your memory is Keeper's.", on: () => held });
const holding = (on) => (held = on);
/** Whether the extension holds the memory of a chat working there. */
const heldAt = (dir) => memoryHeldAt(dir) !== undefined;

const names = (files) => files.map((f) => path.basename(f.path)).sort();
const nova = createAgent({ name: 'Nova' });
for (const f of ['SOUL.md', 'PrimaryUser.md', 'MEMORY.md', 'TEAM.md']) writeFileSync(path.join(nova.home, f), `# ${f} of Nova`);
const project = (name) => {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'AGENTS.md'), 'Answer in German.');
  return dir;
};
const reset = (...projects) => {
  for (const p of projects) clearProjectAgent(p);
  holding(false);
};

test('a project linked to an agent gets its soul, user and memory from the agent home, not from the project folder', () => {
  reset('linked');
  const dir = project('linked');
  // The folder is the agent's to write; what it puts there is not the agent's soul.
  writeFileSync(path.join(dir, 'SOUL.md'), '# planted in the project folder');
  setProjectAgent('linked', { agent: nova.id, memoryOff: false });

  const files = extraContextFiles(dir, 'primary');
  assert.deepEqual(names(files), ['MEMORY.md', 'PrimaryUser.md', 'SOUL.md']);
  assert.ok(files.every((f) => f.path.startsWith(nova.home + path.sep)), 'read from the agent home');
  assert.equal(files.find((f) => f.path.endsWith('SOUL.md')).content, '# SOUL.md of Nova');
  // A chat started in a folder of the project is the project's as well.
  const deeper = path.join(dir, 'src');
  mkdirSync(deeper);
  assert.deepEqual(names(extraContextFiles(deeper)), ['MEMORY.md', 'PrimaryUser.md', 'SOUL.md']);
});

test('a project that works with no agent has only its AGENTS.md: nothing of an agent, not even from its folder', () => {
  reset('blank');
  const dir = project('blank');
  assert.deepEqual(extraContextFiles(dir, 'primary'), []);
  assert.equal(linkedAgent('blank'), undefined);
  assert.equal(agentLinkedAt(dir), undefined);

  // The folder is the agent's to write, and a cloned repository may ship such files: they are only files here.
  for (const f of ['SOUL.md', 'PrimaryUser.md', 'MEMORY.md', 'TEAM.md']) writeFileSync(path.join(dir, f), `# ${f} planted in the project folder`);
  mkdirSync(path.join(dir, 'src'));
  for (const where of [dir, path.join(dir, 'src')]) {
    for (const role of [undefined, 'primary', 'colleague', 'guest']) assert.deepEqual(extraContextFiles(where, role), [], `${role} in ${where}`);
  }
  // Saying nothing for the memory, or switching it off, changes nothing for the files: MEMORY.md is not read either.
  setProjectAgent('blank', { agent: '', memoryOff: true });
  assert.deepEqual(extraContextFiles(dir, 'primary'), []);
});

test('the chat is not told that files in a blank project are its own, and is of a linked project', async () => {
  reset('blank-own', 'linked-own');
  const blank = project('blank-own');
  writeFileSync(path.join(blank, 'SOUL.md'), '# planted');
  const linked = project('linked-own');
  setProjectAgent('linked-own', { agent: nova.id, memoryOff: false });
  const { ownFiles } = await import('../dist/pi/sdk-client.js');
  assert.deepEqual(ownFiles(blank, 'primary'), []);
  const said = ownFiles(linked, 'primary');
  assert.equal(said.length, 1);
  assert.match(said[0], /^SOUL\.md, PrimaryUser\.md, MEMORY\.md of the agent this project works with are yours/);
});

test('while an extension holds the memory of the project, MEMORY.md is left aside; with the project doing without it, it is read', () => {
  reset('memory');
  const dir = project('memory');
  setProjectAgent('memory', { agent: nova.id, memoryOff: false });

  // Nothing holds the memory: the file is the memory.
  assert.equal(heldAt(dir), false);
  assert.deepEqual(names(extraContextFiles(dir)), ['MEMORY.md', 'PrimaryUser.md', 'SOUL.md']);

  holding(true);
  assert.equal(heldAt(dir), true);
  assert.deepEqual(names(extraContextFiles(dir)), ['PrimaryUser.md', 'SOUL.md']);

  // The project's own word: not the extension's memory here, so the agent's MEMORY.md is what it remembers.
  setProjectAgent('memory', { agent: nova.id, memoryOff: true });
  assert.equal(heldAt(dir), false);
  assert.deepEqual(names(extraContextFiles(dir)), ['MEMORY.md', 'PrimaryUser.md', 'SOUL.md']);

  // It is the project that said so: another linked project, and the agent's home, still have the extension's.
  setProjectAgent('other', { agent: nova.id, memoryOff: false });
  assert.equal(heldAt(project('other')), true);
  assert.equal(heldAt(nova.home), true);
  assert.deepEqual(names(extraContextFiles(nova.home)), ['PrimaryUser.md', 'SOUL.md']);
});

test("a blank project has none of the extension's memory: it has no agent whose memory it would be", () => {
  reset('blank-memory', 'other');
  const dir = project('blank-memory');
  holding(true);
  // Not by default, and not for a project that never said anything about it.
  assert.equal(heldAt(dir), false);
  setProjectAgent('blank-memory', { agent: '', memoryOff: false });
  assert.equal(heldAt(dir), false);
  setProjectAgent('blank-memory', { agent: '', memoryOff: true });
  assert.equal(heldAt(dir), false);
  // The agent's home and a plain workspace are not projects.
  assert.equal(heldAt(nova.home), true);
  assert.equal(heldAt(undefined), true);
  // Linked, it is on by default, and the project's own switch turns it off.
  setProjectAgent('blank-memory', { agent: nova.id, memoryOff: false });
  assert.equal(heldAt(dir), true);
  setProjectAgent('blank-memory', { agent: nova.id, memoryOff: true });
  assert.equal(heldAt(dir), false);
  // Nothing to set a project's memory on while nothing holds it.
  holding(false);
  setProjectAgent('blank-memory', { agent: nova.id, memoryOff: false });
  assert.equal(heldAt(dir), false);
});

test('someone who is not the primary user never gets the private half, in a project either', () => {
  reset('guests');
  const dir = project('guests');
  setProjectAgent('guests', { agent: nova.id, memoryOff: false });
  assert.deepEqual(names(extraContextFiles(dir, 'guest')), ['SOUL.md', 'TEAM.md']);
});

test('skills, voice and avatar follow the link: the agent a chat is with', () => {
  reset('with-nova', 'without');
  const dir = project('with-nova');
  const plain = project('without');
  setProjectAgent('with-nova', { agent: nova.id, memoryOff: false });
  assert.equal(agentFor(dir).id, nova.id);
  // As before: a chat in a project that works with no one is the first agent's, and a chat at home is its agent's.
  assert.equal(agentFor(plain).id, defaultAgent().id);
  assert.equal(agentFor(nova.home).id, nova.id);
  assert.equal(agentFor(undefined).id, defaultAgent().id);
});

test('the choice is stored by the project, read back, and forgotten as the project is', () => {
  reset('stored');
  assert.deepEqual(projectAgent('stored'), { agent: '', memoryOff: false });
  setProjectAgent('stored', { agent: nova.id, memoryOff: true });
  assert.deepEqual(projectAgent('stored'), { agent: nova.id, memoryOff: true });
  assert.deepEqual(projectAgents().get('stored'), { agent: nova.id, memoryOff: true });
  // Saying nothing is no row: the project is as it was before it was asked.
  setProjectAgent('stored', { agent: '', memoryOff: false });
  assert.equal(projectAgents().has('stored'), false);
  setProjectAgent('stored', { agent: nova.id, memoryOff: false });
  clearProjectAgent('stored');
  assert.deepEqual(projectAgent('stored'), { agent: '', memoryOff: false });
});

test("a project whose agent is deleted is a blank slate again, and keeps what it said about the agent's memory", () => {
  reset('orphan', 'orphan-memory');
  const dir = project('orphan');
  const gone = createAgent({ name: 'Gone' });
  writeFileSync(path.join(gone.home, 'SOUL.md'), '# Gone');
  setProjectAgent('orphan', { agent: gone.id, memoryOff: false });
  setProjectAgent('orphan-memory', { agent: gone.id, memoryOff: true });
  assert.deepEqual(names(extraContextFiles(dir)), ['SOUL.md']);

  deleteAgent(gone.id, { deleteFolder: false });
  // Even before the row is cleaned up, an agent that is gone is not one to work with.
  assert.equal(linkedAgent('orphan'), undefined);
  assert.deepEqual(extraContextFiles(dir), []);
  releaseProjectsOf(gone.id);
  assert.equal(projectAgents().has('orphan'), false);
  assert.deepEqual(projectAgent('orphan-memory'), { agent: '', memoryOff: true });
});
