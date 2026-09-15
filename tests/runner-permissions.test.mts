import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContainerExecutor} from '../server/src/executors/index.ts';
test('runner uses the portal uid/gid and a pre-created private session directory',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'pitha-runner-'));const saved=process.env.PATH;const prior=process.env.ARG_FILE;
 process.env.PATH=temp+':'+saved;process.env.ARG_FILE=join(temp,'args');
 writeFileSync(join(temp,'docker'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$ARG_FILE"\n',{mode:0o755});
 try {
  const executor=new ContainerExecutor('test-runner',join(temp,'sessions'),{memoryMb:2048,cpus:2,pidsLimit:512});
  const client=await executor.launch({sessionId:'abc',workspacePath:temp});
  await new Promise<void>(resolve=>client.on('exit',()=>resolve()));
  const args=readFileSync(process.env.ARG_FILE!,'utf8').split('\n');
  assert.equal(args[args.indexOf('--user')+1],`${process.getuid!()}:${process.getgid!()}`);
  assert.equal(statSync(join(temp,'sessions','abc')).uid,process.getuid!());
  assert.equal(statSync(join(temp,'sessions','abc')).mode & 0o777,0o700);
  assert.ok(args.includes('--rm'));assert.ok(args.includes('no-new-privileges'));assert.ok(args.includes('ALL'));
 }finally{process.env.PATH=saved;if(prior===undefined)delete process.env.ARG_FILE;else process.env.ARG_FILE=prior;rmSync(temp,{recursive:true,force:true});}
});
