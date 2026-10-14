import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scratch } from './helpers.mts';
import { fakeDocker } from './fake-docker.mts';

test('managed networking automatically migrates running containers, preserves stopped ones and rejoins recreated portals',async()=>{
 const dir=scratch('voice-net-');
 process.env.DOCKER_SOCKET=path.join(dir,'docker.sock');
 process.env.PORTAL_CONTAINER_NAME='portal-test';
 let portalId='portal-one';
 let container:any={Config:{Labels:{'pithagoras.addon':'voice'}},HostConfig:{NetworkMode:'bridge'},State:{Running:true}};
 const docker=await fakeDocker(process.env.DOCKER_SOCKET!,({method,url,path:p,body})=>{
  if(url==='/containers/portal-test/json')return{json:{Id:portalId,State:{Running:true}}};
  if(url==='/containers/pithagoras-voice/json')return{status:container?200:404,json:container};
  if(url.includes('/logs?'))return{json:'services ready'};
  if(p==='/volumes/create'||p.startsWith('/images/'))return{};
  if(url.includes('/stop?')){container.State.Running=false;return{};}
  if(method==='DELETE'){container=null;return{};}
  if(url.startsWith('/containers/create')){container={Config:body,HostConfig:body.HostConfig,State:{Running:false}};return{};}
  if(url.endsWith('/start')){container.State.Running=true;return{};}
 });
 const{calls}=docker;
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try {
  const voice=await import('../core/server/src/extensions/voice-service.ts');
  assert.equal((await voice.status()).state,'installing');
  for(let n=0;n<100&&container?.HostConfig?.NetworkMode!=='container:portal-one';n++)await new Promise(r=>setTimeout(r,10));
  for(let n=0;n<100&&(await voice.status()).busy;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(container.HostConfig.NetworkMode,'container:portal-one');
  assert.equal(container.HostConfig.PortBindings,undefined);
  assert.deepEqual(container.HostConfig.Binds,['pithagoras_voice-models:/voice']);
  assert.equal((await voice.status()).state,'running');
  assert.ok(calls.some(c=>c.method==='DELETE'&&c.url==='/containers/pithagoras-voice?force=true'));
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
 }
});
