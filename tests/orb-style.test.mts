import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ORB, ORB_EYES, ORB_HATS, ORB_ITEM_COLORS, ORB_PALETTES, ORB_PATTERNS, ORB_PERSONALITIES, ORB_PROPS, hexToRgb, itemColor, normalizeOrb } from '../core/server/src/orb-style.ts';

test('nothing stored is the orb as it always was',()=>{
 assert.deepEqual(normalizeOrb(undefined),DEFAULT_ORB);
 assert.deepEqual(normalizeOrb('garbage'),DEFAULT_ORB);
 // The balanced personality with the aurora colours is the orb drawn before styles existed.
 assert.deepEqual(ORB_PERSONALITIES.balanced,{lobes:[3,5],wave:1,attack:0.3,release:0.09,rings:2,bounce:0,wobble:0.12,drift:1,blink:1});
 // No face and nothing worn: the plain orb.
 assert.equal(DEFAULT_ORB.eyes,'none');assert.equal(DEFAULT_ORB.prop,'none');assert.equal(DEFAULT_ORB.hat,'none');
 assert.deepEqual(DEFAULT_ORB.colors,{idle:'#82bcff',input:'#53f7d7',output:'#be9fff',muted:'#a1b3cc'});
 assert.deepEqual(hexToRgb(DEFAULT_ORB.colors.idle),[130,188,255]);
});

test('a chosen style is kept, and anything out of bounds is brought back in',()=>{
 const style=normalizeOrb({personality:'playful',palette:'custom',colors:{idle:'#FFAA00',input:'#00ff00',output:'#0000ff',muted:'#123456'},speed:9,reactivity:-1,glow:1.234,pattern:'stars'});
 assert.equal(style.personality,'playful');
 assert.equal(style.palette,'custom');
 assert.equal(style.colors.idle,'#ffaa00');
 assert.equal(style.speed,2.5);
 assert.equal(style.reactivity,0);
 assert.equal(style.glow,1.23);
 assert.equal(style.pattern,'stars');
});

test('unknown names and malformed colours fall back field by field',()=>{
 const style=normalizeOrb({personality:'angry',palette:'neon',colors:{idle:'red',input:'#12345',output:'#be9fff'},speed:'fast'});
 assert.equal(style.personality,'balanced');
 assert.equal(style.palette,'aurora');
 assert.equal(style.colors.idle,DEFAULT_ORB.colors.idle);
 assert.equal(style.colors.input,DEFAULT_ORB.colors.input);
 assert.equal(style.colors.output,'#be9fff');
 assert.equal(style.speed,1);
 for(const name of Object.keys(ORB_PALETTES))assert.equal(normalizeOrb({palette:name}).palette,name);
});

test('eyes and props are kept when known, and their colours checked',()=>{
 const style=normalizeOrb({eyes:'round',eyeColor:'#00FF88',prop:'headphones',propColor:'#123abc'});
 assert.equal(style.eyes,'round');assert.equal(style.eyeColor,'#00ff88');
 assert.equal(style.prop,'headphones');assert.equal(style.propColor,'#123abc');
 for(const eyes of ORB_EYES)assert.equal(normalizeOrb({eyes}).eyes,eyes);
 for(const prop of ORB_PROPS)assert.equal(normalizeOrb({prop}).prop,prop);
 const odd=normalizeOrb({eyes:'laser',prop:'cape',eyeColor:'white',propColor:42});
 assert.equal(odd.eyes,'none');assert.equal(odd.prop,'none');
 assert.equal(odd.eyeColor,DEFAULT_ORB.eyeColor);assert.equal(odd.propColor,'auto');
});

test('a hat is its own slot, worn with any prop',()=>{
 const style=normalizeOrb({hat:'tophat',hatColor:'#334455',prop:'monocle'});
 assert.equal(style.hat,'tophat');assert.equal(style.hatColor,'#334455');assert.equal(style.prop,'monocle');
 for(const hat of ORB_HATS)assert.equal(normalizeOrb({hat}).hat,hat);
 assert.equal(normalizeOrb({hat:'fez'}).hat,'none');
 assert.equal(normalizeOrb({hatColor:'blue'}).hatColor,'auto');
});

test('hats and props wear their own colour until one is picked',()=>{
 assert.equal(DEFAULT_ORB.hatColor,'auto');assert.equal(DEFAULT_ORB.propColor,'auto');
 assert.equal(normalizeOrb({propColor:'auto'}).propColor,'auto');
 for(const kind of [...ORB_HATS,...ORB_PROPS].filter(k=>k!=='none')){
  assert.match(ORB_ITEM_COLORS[kind],/^#[0-9a-f]{6}$/);
  assert.equal(itemColor(kind,'auto'),ORB_ITEM_COLORS[kind]);
  assert.equal(itemColor(kind,'#123456'),'#123456');
 }
});

test('names an object inherits are not personalities or palettes',()=>{
 for(const name of ['toString','constructor','__proto__','hasOwnProperty']){
  assert.equal(normalizeOrb({personality:name}).personality,'balanced');
  assert.equal(normalizeOrb({palette:name}).palette,'aurora');
 }
});

test('the surface is glossy unless plush is chosen',()=>{
 assert.equal(DEFAULT_ORB.finish,'glossy');
 assert.equal(normalizeOrb({finish:'plush'}).finish,'plush');
 assert.equal(normalizeOrb({finish:'satin'}).finish,'glossy');
});

test('a pattern is kept when known, and the old ribbons switch becomes one',()=>{
 assert.equal(DEFAULT_ORB.pattern,'ribbons');
 for(const pattern of ORB_PATTERNS)assert.equal(normalizeOrb({pattern}).pattern,pattern);
 assert.equal(normalizeOrb({pattern:'plaid'}).pattern,'ribbons');
 // Saved before patterns existed.
 assert.equal(normalizeOrb({ribbons:false}).pattern,'none');
 assert.equal(normalizeOrb({ribbons:true}).pattern,'ribbons');
});

test("the avatar is the orb unless an extension's is chosen, by its key",()=>{
 assert.equal(DEFAULT_ORB.avatar,'orb');
 // Stored before there was a choice.
 assert.equal(normalizeOrb({personality:'calm'}).avatar,'orb');
 for(const avatar of ['',42,null,['test-puppet/puppet'],'x'.repeat(257)])assert.equal(normalizeOrb({avatar}).avatar,'orb');
 assert.equal(normalizeOrb({avatar:'test-puppet/puppet'}).avatar,'test-puppet/puppet');
 assert.equal(normalizeOrb({avatar:'@codacus/notes/'+'x'.repeat(241)}).avatar.length,256);
});
