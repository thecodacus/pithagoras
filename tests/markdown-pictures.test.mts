import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {foreignPictureHost,Markdown} from '../core/web/src/components/Markdown.tsx';

// What a reply, a note or a fetched page says is drawn by Markdown, and the browser fetches any picture it names
// the moment it is drawn: only the portal's own may load.
// tsx draws the components' JSX the classic way, which finds React as a global; the web build does not need that.
(globalThis as any).React=React;
(globalThis as any).window={location:new URL('https://portal.test:4100/chat/1')};
const draw=(text:string,props:object={})=>renderToStaticMarkup(React.createElement(Markdown,{mode:'static',...props},text));
const REMOTE='https://example.invalid/p.png?d=secret';

test('a picture from another site is not an img, a source or a request, and says where it was',()=>{
 for(const text of [
  `![x](${REMOTE})`,
  `<img src="${REMOTE}">`,
  `[![x](${REMOTE})](https://link.invalid)`,
  `<picture><source srcset="${REMOTE}"><img src="/api/own.png"></picture>`,
  `![x](http://127.0.0.1:9999/p.png)`,
 ]){
  const html=draw(text);
  assert.doesNotMatch(html,/<source|srcSet|srcset/i,text);
  assert.doesNotMatch(html,/https?:\/\//,text);
  // The one img of the picture case is the portal's own.
  for(const src of html.matchAll(/<img[^>]* src="([^"]*)"/g)) assert.match(src[1],/^\/api\/own\.png$/,text);
 }
 assert.match(draw(`![x](${REMOTE})`),/Picture from example\.invalid not loaded/);
 assert.doesNotMatch(draw(`![x](${REMOTE})`),/<img/);
});

test("the portal's own pictures still load",()=>{
 const html=draw('![chart](/api/sessions/s1/picture?path=a.png)\n\n![same](https://portal.test:4100/api/b.png)');
 assert.match(html,/<img[^>]*src="\/api\/sessions\/s1\/picture\?path=a\.png"/);
 assert.match(html,/<img[^>]*src="https:\/\/portal\.test:4100\/api\/b\.png"/);
});

test('a protocol-relative address cannot name another site either',()=>{
 assert.doesNotMatch(draw('![x](//example.invalid/p.png)'),/example\.invalid/);
});

test('the guard also holds where a component passes its own components',()=>{
 const html=draw(`![x](${REMOTE})`,{components:{a:(p:any)=>React.createElement('a',p)}});
 assert.doesNotMatch(html,/<img|example\.invalid\/p/);
});

test('which pictures are foreign, by origin and not by look',()=>{
 const page='https://portal.test:4100/chat/1';
 assert.equal(foreignPictureHost('/api/a.png',page),null);
 assert.equal(foreignPictureHost('a.png',page),null);
 assert.equal(foreignPictureHost('https://portal.test:4100/x',page),null);
 assert.equal(foreignPictureHost('data:image/png;base64,AAAA',page),null);
 assert.equal(foreignPictureHost('blob:https://portal.test:4100/6f1c',page),null);
 assert.equal(foreignPictureHost('https://portal.test/x',page),'portal.test','another port is another origin');
 assert.equal(foreignPictureHost('http://portal.test:4100/x',page),'portal.test:4100','another scheme too');
 assert.equal(foreignPictureHost('https://portal.test.evil.invalid:4100/x',page),'portal.test.evil.invalid:4100');
 assert.equal(foreignPictureHost('https://portal.test:4100@evil.invalid/x',page),'evil.invalid');
 assert.equal(foreignPictureHost('data:text/html,<b>x',page),'?');
 assert.equal(foreignPictureHost('blob:https://evil.invalid/6f1c',page),'evil.invalid');
});

test('no component draws Streamdown itself, past the guard',()=>{
 const roots=['../core/web/src'];
 const found:string[]=[];
 const walk=(dir:string)=>{
  for(const entry of readdirSync(new URL(dir+'/',import.meta.url),{withFileTypes:true})){
   const file=path.join(dir,entry.name);
   if(entry.isDirectory()) walk(file);
   else if(/\.tsx?$/.test(entry.name)&&entry.name!=='Markdown.tsx'&&entry.name!=='mermaid.ts'&&/<Streamdown\b/.test(readFileSync(new URL(file,import.meta.url),'utf8'))) found.push(file);
  }
 };
 roots.forEach(walk);
 assert.deepEqual(found,[]);
});
