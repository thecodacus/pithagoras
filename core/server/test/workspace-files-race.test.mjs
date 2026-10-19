import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT, race, root } from './race-harness.mjs';
const { baseDir, removeFile, renameFile, setAgentAccess } = await import('../dist/workspace-files.js');

/**
 * removeFile and renameFile, as root, against an agent that is not (race-harness.mjs): told which folder they are for (`expect`), they never act in
 * the other one; without, they do, which shows that the race is real on this machine.
 */
const removing = (folder, options) => removeFile(baseDir(folder), 'doc.md', options);
const renaming = (folder, options) => renameFile(baseDir(folder), 'doc.md', 'new.md', options);

for (const [what, act] of [['removeFile', removing], ['renameFile', renaming]]) {
  test(`${what} as root never acts in a closed folder that the agent moved onto the documents folder's place, when it is told which folder it is for`, { skip: !root && 'only as root', timeout: 60_000 }, async (t) => {
    const told = await race(act, { expect: true });
    if (!told) return t.skip('the agent\'s user cannot run node here');
    assert.ok(told.rounds > 100, `the agent moved the folders (${told.rounds} rounds)`);
    assert.ok(told.calls > 100, `and the portal called (${told.calls} calls)`);
    assert.equal(told.breaches, 0, `${what}: the closed folder was acted in ${told.breaches} times in ${told.calls} calls`);
    // The same race without the folder named acts in it: the swap is real on this machine, and the folder it was told about is the whole of the difference.
    const free = await race(act, { expect: false });
    if (!free) return t.skip('the agent\'s user cannot run node here');
    assert.ok(free.breaches > 0, `${what}: without expect the closed folder was never acted in (${free.calls} calls, ${free.rounds} rounds): the race did not happen, so the test says nothing`);
  });
}

for (const [what, act] of [['removeFile', removing], ['renameFile', renaming]]) {
  test(`${what} as root never acts in a closed folder that the agent moved onto the documents folder's place, when it is told the folder is to be one the agent could use`, { skip: !root && 'only as root', timeout: 60_000 }, async (t) => {
    // No folder named: the check is on the folder the call holds, so the closed one is turned away whenever it is the one that is there.
    // The agent is the user the racer runs as, in its own group.
    setAgentAccess(() => [{ uid: AGENT, groups: [AGENT] }]);
    const told = await race(act, { likeParent: true }).finally(() => setAgentAccess(() => undefined));
    if (!told) return t.skip('the agent\'s user cannot run node here');
    assert.ok(told.rounds > 100, `the agent moved the folders (${told.rounds} rounds)`);
    assert.ok(told.calls > 100, `and the portal called (${told.calls} calls)`);
    assert.equal(told.breaches, 0, `${what}: the closed folder was acted in ${told.breaches} times in ${told.calls} calls`);
    // The same race without it acts in it: the swap is real on this machine, and the option is the whole of the difference.
    const free = await race(act, {});
    if (!free) return t.skip('the agent\'s user cannot run node here');
    assert.ok(free.breaches > 0, `${what}: without likeParent the closed folder was never acted in (${free.calls} calls, ${free.rounds} rounds): the race did not happen, so the test says nothing`);
  });
}
