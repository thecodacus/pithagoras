import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('managed networking automatically migrates running containers, preserves stopped ones and rejoins recreated portals',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'voice-net-'));
 process.env.DOCKER_SOCKET=path.join(dir,'docker.sock');
 process.env.PORTAL_CONTAINER_NAME='portal-test';
 let portalId='portal-one';
 let container:any={Config:{Labels:{'pithagoras.addon':'voice'}},HostConfig:{NetworkMode:'bridge'},State:{Running:true}};
 const calls:{method:string;url:string;body:any}[]=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  const body=raw?JSON.parse(raw):undefined;const url=req.url!;const method=req.method!;
  calls.push({method,url,body});res.setHeader('Content-Type','application/json');
  if(url==='/containers/portal-test/json')return res.end(JSON.stringify({Id:portalId,State:{Running:true}}));
  if(url==='/containers/pithagoras-voice/json'){res.statusCode=container?200:404;return res.end(JSON.stringify(container));}
  if(url.includes('/logs?'))return res.end(JSON.stringify('services ready'));
  if(url.startsWith('/images/'))return res.end('{}');
  if(url.includes('/stop?'))container.State.Running=false;
  if(method==='DELETE')container=null;
  if(url.startsWith('/containers/create'))container={Config:body,HostConfig:body.HostConfig,State:{Running:false}};
  if(url.endsWith('/start'))container.State.Running=true;
  res.end('{}');
 });
 await new Promise<void>(r=>server.listen(process.env.DOCKER_SOCKET,r));
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try {
  const voice=await import('../server/src/extensions/voice-service.ts');
  assert.equal((await voice.status()).state,'installing');
  for(let n=0;n<100&&container?.HostConfig?.NetworkMode!=='container:portal-one';n++)await new Promise(r=>setTimeout(r,10));
  for(let n=0;n<100&&(await voice.status()).busy;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(container.HostConfig.NetworkMode,'container:portal-one');
  assert.equal(container.HostConfig.PortBindings,undefined);
  assert.deepEqual(container.HostConfig.Binds,['pithagoras_voice-models:/voice']);
  assert.equal((await voice.status()).state,'running');
  assert.ok(calls.some(c=>c.method==='DELETE'&&c.url==='/containers/pithagoras-voice'));
  assert.ok(!calls.some(c=>c.method==='DELETE'&&c.url.startsWith('/volumes')));
  // Updating the portal's identity must reattach the still-running add-on.
  portalId='portal-two';assert.equal((await voice.status()).state,'installing');
  for(let n=0;n<100&&(await voice.status()).busy;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(container.HostConfig.NetworkMode,'container:portal-two');
  container.State.Running=false;container.HostConfig.NetworkMode='bridge';
  const before=calls.length;assert.equal((await voice.status()).state,'stopped');
  assert.ok(calls.slice(before).every(c=>c.method==='GET'));
 }finally{
  globalThis.fetch=oldFetch;
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  rmSync(dir,{recursive:true,force:true});
 }
});
