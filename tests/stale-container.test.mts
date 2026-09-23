import test from 'node:test';
import assert from 'node:assert/strict';
import {removeStoppedRunner} from '../server/src/executors/stale-container.ts';
const fixture=(status='exited',managed='true')=>JSON.stringify([{Id:'immutable-container-id',Config:{Labels:{'pithagoras.managed':managed,'pithagoras.session':'test'}},State:{Status:status}}]);
test('only stopped managed runners are removed, by ID without force',async()=>{
 for(const status of ['created','exited','dead']){
  const calls:string[][]=[];
  await removeStoppedRunner('test',async args=>{calls.push(args);return calls.length===1?fixture(status):''});
  assert.deepEqual(calls,[['container','inspect','pithagoras-test'],['container','rm','immutable-container-id']]);
 }
});
test('running or unrelated containers are never removed',async()=>{
 for(const output of [fixture('running'),fixture('paused'),fixture('restarting'),fixture('exited','false')]){
  let calls=0;
  await assert.rejects(removeStoppedRunner('test',async()=>{calls++;return output}));
  assert.equal(calls,1);
 }
});
test('missing container is normal; daemon and removal failures propagate',async()=>{
 await removeStoppedRunner('test',async()=>{throw Object.assign(new Error(),{stderr:'Error: No such container: pithagoras-test'})});
 await assert.rejects(removeStoppedRunner('test',async()=>{throw Object.assign(new Error('daemon unavailable'),{stderr:'Cannot connect to Docker daemon'})}),/daemon unavailable/);
 let calls=0;
 await assert.rejects(removeStoppedRunner('test',async()=>{if(++calls===1)return fixture();throw new Error('container is running')}),/container is running/);
});
