import test from 'node:test';
import assert from 'node:assert/strict';
import { inProcessHome } from './helpers.mts';
inProcessHome('voice-presets-');
const {addVoice,readVoice,listVoices,updateVoice,deleteVoice,VoiceNotFound}=await import('../core/server/src/voice-presets.js');
const {getDb}=await import('../core/server/src/db.js');
const {validateConfig}=await import('../core/server/src/api/voice.js');
const {samplesWav}=await import('../core/web/src/voice.ts');
test('reference voices persist audio privately and can be selected for synthesis',async()=>{
 const audio=Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
 const voice=addVoice({name:'Test clone',kind:'clone',instruction:'Warm delivery',transcript:'A reference line',audio});
 assert.equal(readVoice(voice.id).audio?.length,32044);assert.ok(!('audio' in (listVoices()[0] as any)));
 const config=validateConfig({enabled:true,voice:voice.id,instruction:'Clear',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b'});assert.equal(config.voice,voice.id);
 getDb().prepare("INSERT INTO settings(key,value) VALUES ('voice',?)").run(JSON.stringify(config));
 deleteVoice(voice.id);assert.throws(()=>readVoice(voice.id),/not found/);
 const saved=JSON.parse((getDb().prepare("SELECT value FROM settings WHERE key='voice'").get() as any).value);assert.equal(saved.voice,'design');assert.equal(saved.breezeUrl,config.breezeUrl);
});
test('designed voices need no recording; invalid references and unknown selections are rejected',()=>{
 const voice=addVoice({name:'Narrator',kind:'design',instruction:'Low, calm voice'});assert.equal(readVoice(voice.id).audio,null);
 assert.throws(()=>addVoice({name:'Bad',kind:'clone',instruction:'Clear',transcript:'Hello',audio:'YWJj'}),/Invalid reference/);
 assert.throws(()=>addVoice({name:'Bad',kind:'clone',instruction:'Clear',transcript:'',audio:''}),/exact words/);
 assert.throws(()=>validateConfig({enabled:true,voice:'missing',instruction:'Clear',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b'}),/not found/);
});
test('a saved voice\'s description can be changed, and only the description',async()=>{
 const audio=Buffer.from(await samplesWav(new Float32Array(16000)).arrayBuffer()).toString('base64');
 const voice=addVoice({name:'Editable',kind:'clone',instruction:'Warm delivery',transcript:'A reference line',audio});
 const before=readVoice(voice.id);
 const row=updateVoice(voice.id,{instruction:'  Bright and quick  '});
 assert.deepEqual(row,{id:voice.id,name:'Editable',kind:'clone',instruction:'Bright and quick',transcript:'A reference line'});
 assert.equal(readVoice(voice.id).instruction,'Bright and quick');
 assert.deepEqual((listVoices() as any[]).find(v=>v.id===voice.id),row);
 assert.deepEqual(readVoice(voice.id).audio,before.audio);
 for(const instruction of ['','  ','x'.repeat(1001),null,7])assert.throws(()=>updateVoice(voice.id,{instruction}),/1–1000 characters/);
 assert.throws(()=>updateVoice(voice.id,undefined),/1–1000 characters/);
 assert.equal(readVoice(voice.id).instruction,'Bright and quick');
 assert.equal(updateVoice(voice.id,{instruction:'x'.repeat(1000)}).instruction.length,1000);
});
test('changing the description of a voice that is not there says so and adds nothing',()=>{
 const count=listVoices().length;
 assert.throws(()=>updateVoice('voice-missing',{instruction:'Clear'}),(e:unknown)=>e instanceof VoiceNotFound&&/not found/.test(e.message));
 assert.throws(()=>readVoice('voice-missing'),(e:unknown)=>e instanceof VoiceNotFound);
 assert.equal(listVoices().length,count);
});
test('the table of saved voices is part of the versioned schema, and the voices never make it themselves',()=>{
 // There before any voice is asked for, and found by the same check as every other table of a fresh database.
 assert.ok(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='voice_presets'").get());
 const db=getDb() as any;const exec=db.exec.bind(db);const prepare=db.prepare.bind(db);const made:string[]=[];
 db.exec=(sql:string)=>{made.push(sql);return exec(sql)};
 db.prepare=(sql:string)=>{if(/CREATE/i.test(sql))made.push(sql);return prepare(sql)};
 try{addVoice({name:'Schema',kind:'design',instruction:'Plain'});listVoices();}finally{delete db.exec;delete db.prepare}
 assert.deepEqual(made,[]);
});
test('a voice setting that does not parse does not stop a voice from being deleted',()=>{
 const voice=addVoice({name:'Doomed',kind:'design',instruction:'Plain voice'});
 for(const broken of ['{not json','null','"design"','[]']){
  getDb().prepare("INSERT INTO settings(key,value) VALUES ('voice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(broken);
  const again=addVoice({name:'Doomed '+broken.length,kind:'design',instruction:'Plain voice'});
  deleteVoice(again.id);assert.throws(()=>readVoice(again.id),/not found/);
  assert.equal((getDb().prepare("SELECT value FROM settings WHERE key='voice'").get() as any).value,broken,'left as it was');
 }
 deleteVoice(voice.id);
});
