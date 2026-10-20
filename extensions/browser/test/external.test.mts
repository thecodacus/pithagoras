import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as browser from '../src/server/service.ts';

test('external browser discovery works without Docker access and cannot manage its lifecycle',async()=>{
 const old=process.env.BROWSER_EXTERNAL,oldUrl=process.env.BROWSER_CDP_URL,original=globalThis.fetch;
 try {
  process.env.BROWSER_EXTERNAL='true';process.env.BROWSER_CDP_URL='http://127.0.0.1:9223';
  globalThis.fetch=async input=>{assert.equal(String(input),'http://127.0.0.1:9223/json/version');return Response.json({Browser:'Chrome/test'});};
  assert.equal((await browser.status()).container,'running');assert.equal((await browser.status()).available,false);
  await assert.rejects(browser.stop(),/managed outside/);
  globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await browser.status()).container,'stopped');
 }finally{globalThis.fetch=original;if(old===undefined)delete process.env.BROWSER_EXTERNAL;else process.env.BROWSER_EXTERNAL=old;if(oldUrl===undefined)delete process.env.BROWSER_CDP_URL;else process.env.BROWSER_CDP_URL=oldUrl;}
});
