import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shellOutcome} from '../core/web/src/components/ChatActivity.tsx';
test('a shell command says how it ended',()=>{
 assert.equal(shellOutcome('running','x'),undefined);
 assert.deepEqual(shellOutcome('done','ok'),{label:'exit 0',tone:'ok'});
 assert.deepEqual(shellOutcome('error','boom\n\nCommand exited with code 127'),{label:'exit 127',tone:'error'});
 assert.deepEqual(shellOutcome('error','…\n\nCommand timed out after 30 seconds'),{label:'timed out · 30s',tone:'warn'});
 assert.deepEqual(shellOutcome('error','\n\nCommand aborted'),{label:'stopped',tone:'warn'});
});
test('a shell tool from another extension is not said to have succeeded on its word alone',()=>{
 assert.deepEqual(shellOutcome('done','Process exited with code 2\nOutput:\nnope',false,'exec_command'),{label:'exit 2',tone:'error'});
 assert.deepEqual(shellOutcome('done','Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nok',false,'exec_command'),{label:'exit 0',tone:'ok'});
 assert.deepEqual(shellOutcome('done','boom\n\nexit code: 2',false,'terminal'),{label:'exit 2',tone:'error'});
 assert.equal(shellOutcome('done','hello',false,'terminal'),undefined);
 assert.deepEqual(shellOutcome('done','hello',false,'bash'),{label:'exit 0',tone:'ok'});
 // A log that mentions an exit code on the way is not the command's.
 assert.equal(shellOutcome('done',['a','b','c','d','e','f','g','step failed with exit code: 1','h','i','j','k','l'].join('\n'),false,'shell'),undefined);
 assert.deepEqual(shellOutcome('error','oops\n[exit code: 3]',false,'shell'),{label:'exit 3',tone:'error'});
});
