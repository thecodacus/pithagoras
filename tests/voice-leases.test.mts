import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceLeases} from '../core/server/src/voice-leases.js';
test('two tabs share a model until the last one disconnects',async()=>{
 const calls:string[]=[];const leases=new VoiceLeases(async()=>{calls.push('load')},async()=>{calls.push('unload')});
 await leases.acquire('a');await leases.acquire('b');await leases.release('a');assert.equal(calls.includes('unload'),false);
 await leases.release('b');assert.equal(calls.at(-1),'unload');
});
test('abandoned leases expire',async()=>{
 let time=0,unloads=0;const leases=new VoiceLeases(async()=>{},async()=>{unloads++},()=>time);
 await leases.acquire('a');time=76000;await leases.sweep();assert.equal(unloads,1);
 await leases.acquire('b');await leases.sweep();assert.equal(unloads,1);
 await leases.release('b');assert.equal(unloads,2);
});
test('disconnect while loading queues unload after the load completes',async()=>{
 let finish!:()=>void;const calls:string[]=[];const leases=new VoiceLeases(()=>new Promise<void>(resolve=>{calls.push('load');finish=resolve}),async()=>{calls.push('unload')});
 const load=leases.acquire('a');await Promise.resolve();const release=leases.release('a');finish();await Promise.all([load,release]);assert.deepEqual(calls,['load','unload']);
});
