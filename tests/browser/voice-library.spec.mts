import { test, expect } from './portal-mock';
import path from 'node:path';
test('upload a voice reference, select it, save settings, and delete it',async({page})=>{
 let config={enabled:true,voice:'design',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b',instruction:'Clear',cfgScale:4};
 let voices:any[]=[];
 await page.route('**/api/voice',r=>{if(r.request().method()==='PUT')config=r.request().postDataJSON();return r.fulfill({json:config});});
 await page.route('**/api/voice/presets',r=>{
  if(r.request().method()==='POST'){
   const body=r.request().postDataJSON();const audio=Buffer.from(body.audio,'base64');expect(audio.toString('ascii',0,4)).toBe('RIFF');expect(audio.readUInt32LE(24)).toBe(16000);expect(audio.readUInt16LE(22)).toBe(1);
   const row={...body,id:'voice-test'};delete row.audio;voices=[row];return r.fulfill({json:row});
  }return r.fulfill({json:voices});
 });
 await page.route('**/api/voice/presets/voice-test',r=>{voices=[];config.voice='design';return r.fulfill({json:{ok:true}});});
 await page.goto('/tests/voice-addon.html');
 await page.getByRole('button',{name:'Add voice',exact:true}).click();
 await page.getByLabel('Voice name',{exact:true}).fill('New narrator');
 await page.getByLabel('Reference recording').setInputFiles(path.resolve('tests/fixtures/jfk.wav'));
 await page.getByLabel('Exact words in the recording').fill('And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.');
 await page.getByRole('button',{name:'Save new voice',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Speaking voice',exact:true})).toHaveText('New narrator');
 await expect(page.getByLabel('Voice reference preview')).toBeVisible();
 await page.getByRole('button',{name:'Save voice settings',exact:true}).click();
 expect(config.voice).toBe('voice-test');
 // The page draws the portal's own dialog, as the app does, not the browser's.
 await page.getByRole('button',{name:'Delete voice',exact:true}).click();
 await page.getByRole('alertdialog').getByRole('button',{name:'Delete',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Speaking voice',exact:true})).toHaveText('Designed voice');
 await expect(page.locator('#error')).toBeEmpty();
});
test('change the description of a saved voice after it was created',async({page})=>{
 let voice={id:'voice-test',name:'Night narrator',kind:'design',instruction:'Warm delivery',transcript:''};
 const patches:any[]=[];let refuse='';
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true,voice:'voice-test',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b',instruction:'Clear',cfgScale:4}}));
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[voice]}));
 await page.route('**/api/voice/presets/voice-test',r=>{
  expect(r.request().method()).toBe('PATCH');patches.push(r.request().postDataJSON());
  if(refuse)return r.fulfill({status:400,json:{error:refuse}});
  voice={...voice,instruction:patches.at(-1).instruction.trim()};return r.fulfill({json:voice});
 });
 await page.goto('/tests/voice-addon.html');
 const description=page.getByLabel('Voice description');const save=page.getByRole('button',{name:'Save description',exact:true});
 await expect(description).toHaveValue('Warm delivery');
 await expect(save).toBeDisabled();
 await description.fill('   ');await expect(save).toBeDisabled();
 await description.fill('  A slow, low voice.  ');await expect(save).toBeEnabled();
 await save.click();
 await expect(description).toHaveValue('A slow, low voice.');
 await expect(save).toBeDisabled();
 expect(patches).toEqual([{instruction:'  A slow, low voice.  '}]);
 await expect(page.locator('#error')).toBeEmpty();
 // A refusal from the server is shown and the text stays for another try.
 refuse='Describe the voice in 1–1000 characters';
 await description.fill('Another voice.');await save.click();
 await expect(page.locator('#error')).toHaveText(refuse);
 await expect(description).toHaveValue('Another voice.');await expect(save).toBeEnabled();
});
test('Save voice settings also saves an edited voice description, and does not claim to when it cannot',async({page})=>{
 let voice={id:'voice-test',name:'Night narrator',kind:'design',instruction:'Warm delivery',transcript:''};
 const calls:string[]=[];let refuse='';
 await page.route('**/api/voice',r=>{
  const config={enabled:true,voice:'voice-test',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b',instruction:'Clear',cfgScale:4};
  if(r.request().method()==='PUT'){calls.push('PUT');return r.fulfill({json:r.request().postDataJSON()});}
  return r.fulfill({json:config});
 });
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[voice]}));
 await page.route('**/api/voice/presets/voice-test',r=>{
  const {instruction}=r.request().postDataJSON();calls.push('PATCH '+instruction);
  if(refuse)return r.fulfill({status:400,json:{error:refuse}});
  voice={...voice,instruction:instruction.trim()};return r.fulfill({json:voice});
 });
 await page.goto('/tests/voice-addon.html');
 const description=page.getByLabel('Voice description');const saveSettings=page.getByRole('button',{name:/^(Save voice settings|Saved)$/});
 await expect(description).toHaveValue('Warm delivery');
 // Nothing edited: the settings are saved as before, without touching the voice.
 await saveSettings.click();await expect(saveSettings).toHaveText('Saved');
 expect(calls).toEqual(['PUT']);
 // An edit is not saved yet, and the button no longer says it is.
 await description.fill('A slow, low voice.');
 await expect(saveSettings).toHaveText('Save voice settings');
 await saveSettings.click();
 await expect(saveSettings).toHaveText('Saved');
 expect(calls).toEqual(['PUT','PATCH A slow, low voice.','PUT']);
 await expect(description).toHaveValue('A slow, low voice.');
 await expect(page.getByRole('button',{name:'Save description',exact:true})).toBeDisabled();
 await expect(page.locator('#error')).toBeEmpty();
 // A description the server refuses stops the save: the error is shown, the settings are not claimed as saved.
 refuse='Describe the voice in 1–1000 characters';
 await description.fill('');
 await expect(saveSettings).toHaveText('Save voice settings');
 await saveSettings.click();
 await expect(page.locator('#error')).toHaveText(refuse);
 await expect(saveSettings).toHaveText('Save voice settings');
 expect(calls).toEqual(['PUT','PATCH A slow, low voice.','PUT','PATCH ']);
});
test('a description edited on one voice survives looking at another voice',async({page})=>{
 let voices=[{id:'voice-a',name:'Anna',kind:'design',instruction:'Warm delivery',transcript:''},{id:'voice-b',name:'Bruno',kind:'design',instruction:'Dry delivery',transcript:''}];
 const patches:string[]=[];
 await page.route('**/api/voice',r=>r.fulfill({json:r.request().method()==='PUT'?r.request().postDataJSON():{enabled:true,voice:'voice-a',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b',instruction:'Clear',cfgScale:4}}));
 await page.route('**/api/voice/presets',r=>r.fulfill({json:voices}));
 await page.route('**/api/voice/presets/*',r=>{
  const id=r.request().url().split('/').pop()!;const {instruction}=r.request().postDataJSON();patches.push(`${id} ${instruction}`);
  const row={...voices.find(v=>v.id===id)!,instruction};voices=voices.map(v=>v.id===id?row:v);return r.fulfill({json:row});
 });
 await page.goto('/tests/voice-addon.html');
 const description=page.getByLabel('Voice description');const picker=page.getByRole('combobox',{name:'Speaking voice',exact:true});
 await expect(description).toHaveValue('Warm delivery');
 await description.fill('A bright voice.');
 await picker.click();await page.getByRole('option',{name:/Bruno/}).click();
 await expect(description).toHaveValue('Dry delivery');
 await picker.click();await page.getByRole('option',{name:/Anna/}).click();
 await expect(description).toHaveValue('A bright voice.');
 await page.getByRole('button',{name:'Save voice settings',exact:true}).click();
 await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
 expect(patches).toEqual(['voice-a A bright voice.']);
});
test('an emptied description on another voice does not block saving the settings',async({page})=>{
 const voices=[{id:'voice-a',name:'Anna',kind:'design',instruction:'Warm delivery',transcript:''},{id:'voice-b',name:'Bruno',kind:'design',instruction:'Dry delivery',transcript:''}];
 const calls:string[]=[];
 await page.route('**/api/voice',r=>{
  if(r.request().method()==='PUT'){const saved=r.request().postDataJSON();calls.push('PUT '+saved.voice);return r.fulfill({json:saved});}
  return r.fulfill({json:{enabled:true,voice:'voice-a',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b',instruction:'Clear',cfgScale:4}});
 });
 await page.route('**/api/voice/presets',r=>r.fulfill({json:voices}));
 await page.route('**/api/voice/presets/*',r=>{calls.push('PATCH '+r.request().url().split('/').pop());return r.fulfill({status:400,json:{error:'Describe the voice in 1–1000 characters'}});});
 await page.goto('/tests/voice-addon.html');
 const description=page.getByLabel('Voice description');const picker=page.getByRole('combobox',{name:'Speaking voice',exact:true});
 await description.fill('');
 await picker.click();await page.getByRole('option',{name:/Bruno/}).click();
 await expect(description).toHaveValue('Dry delivery');
 await page.getByRole('button',{name:'Save voice settings',exact:true}).click();
 await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
 expect(calls).toEqual(['PUT voice-b']);
 await expect(page.locator('#error')).toBeEmpty();
 // The emptied text is still there when that voice is looked at again, to be written or left.
 await picker.click();await page.getByRole('option',{name:/Anna/}).click();
 await expect(description).toHaveValue('');
});
test('text typed while a description is being saved is kept',async({page})=>{
 let voice={id:'voice-test',name:'Night narrator',kind:'design',instruction:'Warm delivery',transcript:''};
 const patches:string[]=[];let answer!:()=>void;const answered=new Promise<void>(r=>{answer=r;});
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true,voice:'voice-test',whisperUrl:'http://localhost/a',breezeUrl:'http://localhost/b',instruction:'Clear',cfgScale:4}}));
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[voice]}));
 await page.route('**/api/voice/presets/voice-test',async r=>{
  const {instruction}=r.request().postDataJSON();patches.push(instruction);
  await answered;voice={...voice,instruction};return r.fulfill({json:voice});
 });
 await page.goto('/tests/voice-addon.html');
 const description=page.getByLabel('Voice description');const save=page.getByRole('button',{name:'Save description',exact:true});
 await description.fill('First edit.');await save.click();
 await expect.poll(()=>patches.length).toBe(1);
 await description.fill('First edit. And more typed while saving.');
 answer();
 await expect(save).toBeEnabled();
 await expect(description).toHaveValue('First edit. And more typed while saving.');
 await save.click();
 await expect.poll(()=>patches.length).toBe(2);
 await expect(save).toBeDisabled();
 expect(patches).toEqual(['First edit.','First edit. And more typed while saving.']);
});
