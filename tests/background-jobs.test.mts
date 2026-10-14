import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {listJobs, readOutput, stopJob, MARKER} from '../core/server/src/background.ts';
import { writeFileSync } from 'node:fs';
import { scratch } from "./helpers.mts";
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('a detached job the agent left running is found, followed and stopped',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const [k,v]=MARKER.split('=');
 const child=spawn('sh',['-c','echo started; sleep 30; true'],{cwd:ws,detached:true,stdio:['ignore',(await import('node:fs')).openSync(path.join(ws,'out.log'),'w'),'ignore'],env:{...process.env,[k]:v}});
 child.unref();
 const stranger=spawn('sh',['-c','sleep 30'],{cwd:ws,detached:true,stdio:'ignore',env:{...process.env,[k]:''}});
 try{
  await wait(300);
  const jobs=await listJobs(ws);
  assert.equal(jobs.length,1);
  const job=jobs[0];
  assert.deepEqual([job.command,job.state,job.hasOutput],['echo started; sleep 30; true','running',true]);
  assert.equal((await readOutput(ws,job.key))?.text,'started\n');
  await listJobs(ws);
  assert.equal(await stopJob(ws,job.key),true);
  await wait(300);
  const after=(await listJobs(ws)).find(j=>j.key===job.key);
  assert.equal(after?.state,'exited');
 }finally{try{process.kill(-child.pid!,'SIGKILL')}catch{} try{process.kill(-stranger.pid!,'SIGKILL')}catch{}}
});
const agentEnv=()=>{const [k,v]=MARKER.split('=');return {...process.env,[k]:v};};
test('a workspace reached through a link still has its jobs found',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const link=path.join(realpathSync(tmpdir()),`bg-link-${process.pid}`);
 (await import('node:fs')).symlinkSync(ws,link);
 const child=spawn('sh',['-c','sleep 30'],{cwd:ws,detached:true,stdio:'ignore',env:agentEnv()});
 child.unref();
 try{
  await wait(300);
  assert.equal((await listJobs(link)).filter(j=>j.state==='running').length,1);
 }finally{try{process.kill(-child.pid!,'SIGKILL')}catch{} (await import('node:fs')).unlinkSync(link);}
});
test('a job whose shell exits while what it started goes on stays one job',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const fs=await import('node:fs');
 // `npm run dev > dev.log &` and then the shell ends: the server is the job now.
 const child=spawn('sh',['-c','sleep 30 & sleep 0.4'],{cwd:ws,detached:true,stdio:['ignore',fs.openSync(path.join(ws,'dev.log'),'w'),'ignore'],env:agentEnv()});
 child.unref();
 try{
  await wait(200);
  const [first]=await listJobs(ws);
  await wait(1300);
  const after=await listJobs(ws);
  assert.deepEqual(after.map(j=>[j.key,j.state,j.command]),[[first.key,'running','sleep 30 & sleep 0.4']]);
 }finally{try{process.kill(-child.pid!,'SIGKILL')}catch{}}
});
test('what the portal runs in its own session is not a job of the agent\'s',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const fs=await import('node:fs');
 // The terminal's wrapper, a subagent's pi: started by the portal, marked, and in its session.
 const child=spawn('sh',['-c','sleep 30'],{cwd:ws,stdio:['ignore',fs.openSync(path.join(ws,'out.log'),'w'),'ignore'],env:agentEnv()});
 try{
  await wait(300);
  assert.deepEqual(await listJobs(ws),[]);
 }finally{child.kill('SIGKILL');}
});
test('a job whose processes all change between two looks is still the one job',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const fs=await import('node:fs');
 // `npm install && nohup npm start &`: the install ends, the shell forks the server and ends.
 const child=spawn('sh',['-c','sleep 0.6; sleep 30 & sleep 0.2'],{cwd:ws,detached:true,stdio:['ignore',fs.openSync(path.join(ws,'app.log'),'w'),'ignore'],env:agentEnv()});
 child.unref();
 try{
  await wait(200);
  const [first]=await listJobs(ws);
  await wait(1500);
  const after=await listJobs(ws);
  assert.deepEqual(after.map(j=>[j.key,j.state]),[[first.key,'running']]);
 }finally{try{process.kill(-child.pid!,'SIGKILL')}catch{}}
});
test('a job in a workspace inside another is the job of both, for each to follow and stop',{skip:process.platform!=='linux'},async()=>{
 const outer=realpathSync(scratch('bg-'));
 const inner=path.join(outer,'proj');
 const fs=await import('node:fs');
 fs.mkdirSync(inner);
 const child=spawn('sh',['-c','echo hi; sleep 30'],{cwd:inner,detached:true,stdio:['ignore',fs.openSync(path.join(inner,'out.log'),'w'),'ignore'],env:agentEnv()});
 child.unref();
 try{
  await wait(300);
  const [a]=await listJobs(outer);
  const [b]=await listJobs(inner);
  assert.equal(a.key,b.key);
  // The inner chat looked last: the outer one can still read and stop it.
  assert.equal((await readOutput(outer,a.key))?.text,'hi\n');
  assert.equal(await stopJob(outer,a.key),true);
 }finally{try{process.kill(-child.pid!,'SIGKILL')}catch{}}
});
test('a tool call pi is running is not a job, whoever runs it and wherever its output goes; an extension\'s server is',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const opts={cwd:ws,detached:true,env:agentEnv()} as const;
 // This process stands for the portal. Its bash tool: a shell in a session of its own, its output back to it.
 // bash, as pi runs it: a dash (sh on Debian and Ubuntu) applies the redirection to itself, so its own output is the file.
 const call=spawn('bash',['-c','sleep 30 > test.log 2>&1'],{...opts,stdio:['ignore','pipe','pipe']});
 // A subagent's pi, in the portal's session, runs its own bash tool.
 const child=spawn(process.execPath,['-e',`require('child_process').spawn('sh',['-c','sleep 31'],{detached:true,stdio:['ignore','pipe','pipe']});setTimeout(()=>{},30000)`],{cwd:ws,env:agentEnv(),stdio:['ignore','pipe','pipe']});
 // An extension's server, read through a pipe: a job.
 const server=spawn('sleep',['32'],{...opts,stdio:['ignore','pipe','pipe']});
 try{
  await wait(500);
  // While tool calls are running in the chat: the processes they started are them.
  const during=await listJobs(ws,true);
  const by=(c:string)=>during.find(j=>j.command===c);
  assert.equal(by('sleep 30 > test.log 2>&1')?.attached,true,'the portal\'s tool call, writing to a file');
  assert.equal(by('sleep 31')?.attached,true,'a subagent\'s tool call, its shell handed over to the command');
  // With none running, the same shape is an extension's server, and a job.
  assert.equal((await listJobs(ws,false)).find(j=>j.command==='sleep 32')?.attached,false,'an extension\'s server');
 }finally{for(const p of [call,server])try{process.kill(-p.pid!,'SIGKILL')}catch{} child.kill('SIGKILL'); spawn('pkill',['-f','^sleep 31$']);}
});
test('stopping a job stops all of it, what left the workspace too',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const fs=await import('node:fs');
 const job=spawn('sh',['-c','(cd / && exec sleep 33) & sleep 34'],{cwd:ws,detached:true,stdio:['ignore',fs.openSync(path.join(ws,'out.log'),'w'),'ignore'],env:agentEnv()});
 job.unref();
 try{
  await wait(300);
  const [found]=await listJobs(ws);
  assert.equal(await stopJob(ws,found.key),true);
  await wait(300);
  const left=(await import('node:child_process')).execFileSync('sh',['-c',`ps -o pid= -s ${job.pid} || true`]).toString().trim();
  assert.equal(left,'','nothing of the session is left');
 }finally{try{process.kill(-job.pid!,'SIGKILL')}catch{}}
});
test('output is cut between characters, never inside one',{skip:process.platform!=='linux'},async()=>{
 const ws=realpathSync(scratch('bg-'));
 const log=path.join(ws,'vite.log');
 const arrow=Buffer.from('➜');
 // A write the process has not finished: the arrow's last byte is still to come.
 writeFileSync(log,Buffer.concat([Buffer.from('  '),arrow,Buffer.from(' Local\n'),arrow.subarray(0,2)]));
 const fs=await import('node:fs');
 const job=spawn('sh',['-c','sleep 35'],{cwd:ws,detached:true,stdio:['ignore',fs.openSync(log,'a'),'ignore'],env:agentEnv()});
 job.unref();
 try{
  await wait(300);
  const [found]=await listJobs(ws);
  const all=await readOutput(ws,found.key);
  assert.equal(all?.text,'  ➜ Local\n');
  assert.equal(all?.size,2+3+7,'the partial arrow is left for next time');
  // A start inside the first arrow: from its end.
  const mid=await readOutput(ws,found.key,3);
  assert.equal(mid?.text,' Local\n');
  assert.equal(mid?.from,5);
 }finally{try{process.kill(-job.pid!,'SIGKILL')}catch{}}
});
