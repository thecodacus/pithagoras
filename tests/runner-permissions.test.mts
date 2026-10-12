import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {ContainerExecutor,HostExecutor} from '../server/src/executors/index.ts';
import { scratch } from './helpers.mts';
test('runner uses the portal uid/gid and a pre-created private session directory',async()=>{
 const temp=scratch('pitha-runner-');const saved=process.env.PATH;const prior=process.env.ARG_FILE;
 process.env.PATH=temp+':'+saved;process.env.ARG_FILE=join(temp,'args');
 // Behaves like docker for `container inspect`: a missing name exits non-zero
 // with "No such container", which is what the stale-runner reclaim expects.
 writeFileSync(join(temp,'docker'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$ARG_FILE"\nif [ "$1" = "container" ] && [ "$2" = "inspect" ]; then echo "Error: No such container: $3" >&2; exit 1; fi\n',{mode:0o755});
 try {
  const executor=new ContainerExecutor('test-runner',join(temp,'sessions'),{memoryMb:2048,cpus:2,pidsLimit:512});
  const client=await executor.launch({sessionId:'abc',workspacePath:temp});
  await new Promise<void>(resolve=>client.on('exit',()=>resolve()));
  const args=readFileSync(process.env.ARG_FILE!,'utf8').split('\n');
  assert.equal(args[args.indexOf('--user')+1],`${process.getuid!()}:${process.getgid!()}`);
  assert.equal(statSync(join(temp,'sessions','abc')).uid,process.getuid!());
  assert.equal(statSync(join(temp,'sessions','abc')).mode & 0o777,0o700);
  assert.ok(args.includes('--rm'));assert.ok(args.includes('--init'),'an init as PID 1, which collects what the agent\'s commands leave behind');assert.ok(args.includes('no-new-privileges'));assert.ok(args.includes('ALL'));
 }finally{process.env.PATH=saved;if(prior===undefined)delete process.env.ARG_FILE;else process.env.ARG_FILE=prior;rmSync(temp,{recursive:true,force:true});}
});

test('provider keys reach the container by name, never as a value on the docker command line',async()=>{
 const temp=scratch('pitha-runner-keys-');const saved={PATH:process.env.PATH,ARG_FILE:process.env.ARG_FILE,KEY_FILE:process.env.KEY_FILE,OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,PI_MODEL:process.env.PI_MODEL};
 process.env.PATH=temp+':'+saved.PATH;process.env.ARG_FILE=join(temp,'args');process.env.KEY_FILE=join(temp,'key');
 process.env.OPENROUTER_API_KEY='sk-or-example-secret-value';process.env.PI_MODEL='some/model';
 // Records its arguments, and the one key as docker would copy it from its environment.
 writeFileSync(join(temp,'docker'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$ARG_FILE"\nprintf "%s" "$OPENROUTER_API_KEY" > "$KEY_FILE"\nif [ "$1" = "container" ] && [ "$2" = "inspect" ]; then echo "Error: No such container: $3" >&2; exit 1; fi\n',{mode:0o755});
 try {
  const executor=new ContainerExecutor('test-runner',join(temp,'sessions'),{memoryMb:2048,cpus:2,pidsLimit:512});
  const client=await executor.launch({sessionId:'abc',workspacePath:temp});
  await new Promise<void>(resolve=>client.on('exit',()=>resolve()));
  const args=readFileSync(process.env.ARG_FILE!,'utf8').split('\n');
  assert.ok(args.some((a,i)=>a==='OPENROUTER_API_KEY'&&args[i-1]==='-e'),'named, so that docker takes the value from its environment');
  assert.ok(args.some((a,i)=>a==='PI_MODEL'&&args[i-1]==='-e'));
  assert.equal(args.join('\n').includes('sk-or-example-secret-value'),false,'the value is not in the arguments');
  assert.equal(readFileSync(process.env.KEY_FILE!,'utf8'),'sk-or-example-secret-value','and docker still has it in its environment to copy');
 }finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(temp,{recursive:true,force:true});}
});

test('a container is given the key of the provider its chat runs on, and no other provider\'s',async()=>{
 const temp=scratch('pitha-runner-one-key-');const names=['OPENROUTER_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'];
 const saved:Record<string,string|undefined>={PATH:process.env.PATH,ARG_FILE:process.env.ARG_FILE};for(const k of names)saved[k]=process.env[k];
 process.env.PATH=temp+':'+saved.PATH;process.env.ARG_FILE=join(temp,'args');for(const k of names)process.env[k]=`value-of-${k}`;
 writeFileSync(join(temp,'docker'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$ARG_FILE"\nif [ "$1" = "container" ] && [ "$2" = "inspect" ]; then echo "Error: No such container: $3" >&2; exit 1; fi\n',{mode:0o755});
 const passed=async(provider:string)=>{
  const executor=new ContainerExecutor('test-runner',join(temp,'sessions'),{memoryMb:2048,cpus:2,pidsLimit:512});
  const client=await executor.launch({sessionId:'abc',workspacePath:temp,provider});
  await new Promise<void>(resolve=>client.on('exit',()=>resolve()));
  const args=readFileSync(process.env.ARG_FILE!,'utf8').split('\n');
  return names.filter(k=>args.some((a,i)=>a===k&&args[i-1]==='-e'));
 };
 try {
  assert.deepEqual(await passed('anthropic'),['ANTHROPIC_API_KEY']);
  assert.deepEqual(await passed('openrouter'),['OPENROUTER_API_KEY']);
  assert.deepEqual(await passed('llama-server'),[],'a provider of its own takes no cloud key');
 }finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(temp,{recursive:true,force:true});}
});

test('a container is said not to resume its conversation exactly while it starts pi without the conversation\'s file, and the host does',async()=>{
 const temp=scratch('pitha-runner-resume-');const saved={PATH:process.env.PATH,ARG_FILE:process.env.ARG_FILE};
 process.env.PATH=temp+':'+saved.PATH;process.env.ARG_FILE=join(temp,'args');
 writeFileSync(join(temp,'docker'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$ARG_FILE"\nif [ "$1" = "container" ] && [ "$2" = "inspect" ]; then echo "Error: No such container: $3" >&2; exit 1; fi\n',{mode:0o755});
 try {
  const executor=new ContainerExecutor('test-runner',join(temp,'sessions'),{memoryMb:2048,cpus:2,pidsLimit:512});
  const client=await executor.launch({sessionId:'abc',workspacePath:temp,sessionFile:'/sessions/abc/conversation.jsonl'});
  await new Promise<void>(resolve=>client.on('exit',()=>resolve()));
  const args=readFileSync(process.env.ARG_FILE!,'utf8').split('\n');
  // The idle reaper leaves a chat alone for as long as this is false; when pi is given its file, this is to say so.
  assert.equal(args.includes('--session')||args.includes('--continue'),executor.resumes!==false);
  assert.equal(executor.resumes,false);
  assert.notEqual(new HostExecutor(join(temp,'sessions')).resumes,false);
 }finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(temp,{recursive:true,force:true});}
});
