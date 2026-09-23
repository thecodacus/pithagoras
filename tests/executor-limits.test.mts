import test from 'node:test';
import assert from 'node:assert/strict';
import {executorLimits} from '../server/src/executors/limits.ts';
test('unset limits inherit and positive custom limits are preserved',()=>{
 assert.deepEqual(executorLimits({}),{memoryMb:2048,cpus:2,pidsLimit:512});
 assert.deepEqual(executorLimits({TASK_MEMORY_MB:'4096',TASK_CPUS:'0.5',TASK_PIDS_LIMIT:'100'}),{memoryMb:4096,cpus:0.5,pidsLimit:100});
});
test('zero, negative and malformed values never silently become defaults',()=>{
 for(const key of ['TASK_MEMORY_MB','TASK_CPUS','TASK_PIDS_LIMIT'])for(const value of ['0','-1','wrong','Infinity'])assert.throws(()=>executorLimits({[key]:value}),new RegExp(key));
 assert.throws(()=>executorLimits({TASK_MEMORY_MB:'2'}),/TASK_MEMORY_MB/);
 assert.throws(()=>executorLimits({TASK_PIDS_LIMIT:'1.5'}),/TASK_PIDS_LIMIT/);
});
