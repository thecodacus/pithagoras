import { test, expect } from './portal-mock';

// Settings → Add-ons → Voice: voice mode's own settings. The voice service, which voice mode can listen and speak through,
// is an extension's (extensions/voice), with a page of its own.
const config = { enabled: false, whisperUrl: 'http://127.0.0.1:8178/inference', breezeUrl: 'http://127.0.0.1:7860/v1/audio/speech', instruction: 'Clear speech', voice: 'design', runtime: 'breeze', language: 'auto', cfgScale: 4 };
test('speech detection settings save and restore defaults',async({page})=>{
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp'};
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice',async r=>{if(r.request().method()==='PUT')config=r.request().postDataJSON();await r.fulfill({json:config});});
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Speech detection'}).click();
 const silence=page.getByRole('slider',{name:/End-of-turn silence/});
 await expect(silence).toHaveValue('1000');await silence.fill('500');
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect.poll(()=>config.vad?.redemptionMs).toBe(500);
 await page.reload();await page.locator('summary').filter({hasText:'Speech detection'}).click();
 await expect(silence).toHaveValue('500');
 await page.getByRole('button',{name:'Reset speech detection'}).click();
 await expect(silence).toHaveValue('1000');
});

test('speaking instructions show the built-in text, save an edit and reset to the built-in text',async({page})=>{
 const builtIn='Built-in speaking instructions for this test.';
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp'};
 const puts:any[]=[];
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 // As the server answers: the text in use and the built-in one, and the built-in text saved as nothing.
 const shown=()=>({...config,responseInstructions:config.responseInstructions||builtIn,defaultResponseInstructions:builtIn,responseInstructionsOff:false});
 await page.route('**/api/voice',async r=>{
  if(r.request().method()==='PUT'){const body=r.request().postDataJSON();puts.push(body);config={...body,responseInstructions:body.responseInstructions.trim()===builtIn?'':body.responseInstructions.trim()};}
  return r.fulfill({json:shown()});
 });
 await page.goto('/tests/voice-addon.html');
 await expect(page.getByText('This portal is set to send no speaking instructions')).toBeHidden();
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 const text=page.getByRole('textbox',{name:'Speaking instructions'});
 const reset=page.getByRole('button',{name:'Reset to default'});
 await expect(text).toHaveValue(builtIn);
 await expect(reset).toBeDisabled();
 await text.fill('Answer in one word.');
 await expect(reset).toBeEnabled();
 const save=page.getByRole('button',{name:'Save voice settings'}),saved=page.getByRole('button',{name:'Saved',exact:true});
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts.at(-1).responseInstructions).toBe('Answer in one word.');
 // Saved as it is, and the built-in text still there to reset to.
 await expect(text).toHaveValue('Answer in one word.');
 await reset.click();
 await expect(text).toHaveValue(builtIn);
 await expect(reset).toBeDisabled();
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts).toHaveLength(2);
 expect(puts[1].responseInstructions).toBe('');
 expect(config.responseInstructions).toBe('');
 // Emptied to write a new text, it stays empty while being written, and is the built-in text once saved.
 await text.fill('');
 await expect(text).toHaveValue('');
 await save.click();
 await expect(saved).toBeVisible();
 await expect(text).toHaveValue(builtIn);
 await page.reload();
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 await expect(text).toBeVisible();
 await expect(text).toHaveValue(builtIn);
 await reset.scrollIntoViewIfNeeded();
});

test('speaking instructions say when the portal is set to send none',async({page})=>{
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp',responseInstructions:'Kept text.',defaultResponseInstructions:'Built-in.',responseInstructionsOff:true}}));
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 await expect(page.getByRole('status').filter({hasText:'VOICE_RESPONSE_INSTRUCTIONS=false'})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Speaking instructions'})).toHaveValue('Kept text.');
});

test('saving other voice settings does not pin the built-in text of an older portal',async({page})=>{
 // The portal is updated, with new built-in text, while this page is open.
 let builtIn='Built-in text before the update.';
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp',responseInstructions:''};
 const puts:any[]=[];
 const shown=()=>({...config,responseInstructions:config.responseInstructions||builtIn,defaultResponseInstructions:builtIn,responseInstructionsOff:false});
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice',async r=>{
  if(r.request().method()==='PUT'){const body=r.request().postDataJSON();puts.push(body);config={...body,responseInstructions:body.responseInstructions.trim()===builtIn?'':body.responseInstructions.trim()};}
  return r.fulfill({json:shown()});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 const text=page.getByRole('textbox',{name:'Speaking instructions'});
 await expect(text).toHaveValue('Built-in text before the update.');
 builtIn='Built-in text after the update.';
 await page.locator('summary').filter({hasText:'Speech detection'}).click();
 await page.getByRole('slider',{name:/End-of-turn silence/}).fill('500');
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
 expect(puts[0].responseInstructions).toBe('');
 expect(config.responseInstructions).toBe('');
 await expect(text).toHaveValue('Built-in text after the update.');
 // A text of the user's own is saved as it is.
 await text.fill('Answer in one word.');
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
 expect(puts[1].responseInstructions).toBe('Answer in one word.');
});

test('a voice mode without speech synthesis is a listening one: the settings say so and offer nothing to speak with',async({page})=>{
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:true,runtime:'none',breezeUrl:'',speech:false}}));
 await page.goto('/tests/voice-addon.html');
 await expect(page.getByRole('status').filter({hasText:'This installation has no speech synthesis: replies are not spoken and voice mode is off. Dictation, which only listens, works.'})).toBeVisible();
 await expect(page.getByRole('checkbox',{name:'Enable dictation in sessions'})).toBeChecked();
 // Nothing of the speaking side: the voice, how it is generated, how the assistant is told to speak.
 await expect(page.getByRole('heading',{name:'Your voice'})).toHaveCount(0);
 await expect(page.getByText('Speech generation')).toHaveCount(0);
 await expect(page.locator('summary').filter({hasText:'Speaking instructions'})).toHaveCount(0);
 // What listening has stays: the language, how turns are told apart, and where it listens.
 await expect(page.getByLabel('Input language')).toBeVisible();
 await expect(page.locator('summary').filter({hasText:'Speech detection'})).toBeVisible();
 await page.locator('summary').filter({hasText:'Advanced connection'}).click();
 await expect(page.getByLabel('Speech recognition URL')).toBeVisible();
 await expect(page.getByLabel('Speech synthesis URL')).toHaveCount(0);
 await expect(page.getByRole('combobox',{name:'Speech runtime'})).toContainText('No speech synthesis');
});

test('with Kokoro the voice list is its own voices, and its speed replaces the generation setting',async({page})=>{
 const puts:any[]=[];
 let saved:any={...config,enabled:true,runtime:'kokoro',breezeUrl:'http://127.0.0.1:7862/v1/audio/speech',voice:'voice-1',kokoroVoice:'af_heart',speed:1};
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[{id:'voice-1',name:'Library clone',kind:'clone',instruction:'Warm.',transcript:'Hello.'}]}));
 await page.route('**/api/voice',async r=>{if(r.request().method()==='PUT'){saved=r.request().postDataJSON();puts.push(saved);}await r.fulfill({json:saved});});
 await page.goto('/tests/voice-addon.html');
 const voice=page.getByRole('combobox',{name:'Speaking voice'});
 await expect(voice).toContainText('Heart');
 await voice.click();
 await expect(page.getByRole('option',{name:/Emma.*British English · female/})).toBeVisible();
 await expect(page.getByRole('option',{name:/Library clone|Designed voice/})).toHaveCount(0);
 await expect(page.getByRole('option',{name:/Japanese/})).toHaveCount(0);
 await page.getByRole('option',{name:/Emma/}).click();
 await expect(page.getByText('Speech generation')).toHaveCount(0);
 await page.getByRole('combobox',{name:'Speaking speed'}).click();
 await page.getByRole('option',{name:'Faster'}).click();
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect.poll(()=>puts.length).toBe(1);
 // The library voice is kept for the other engines.
 expect([puts[0].kokoroVoice,puts[0].speed,puts[0].voice]).toEqual(['bf_emma',1.15,'voice-1']);
 // Another engine has the library again.
 await page.locator('summary').filter({hasText:'Advanced connection'}).click();
 await page.getByRole('combobox',{name:'Speech runtime'}).click();
 await page.getByRole('option',{name:/Breeze audio\.cpp/}).click();
 await expect(voice).toContainText('Library clone');
});

test('the providers that reply without thinking first: the list is typed with commas, saved as the server keeps it, and reset to the default one',async({page})=>{
 const builtIn=['llama.cpp','llama-server','llama-swap'];
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp'};
 const puts:any[]=[];
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 // As the server answers: the list in use, the default one to go back to, and a list saved each name once.
 const shown=()=>({...config,skipThinkingProviders:config.skipThinkingProviders??builtIn,defaultSkipThinkingProviders:builtIn});
 await page.route('**/api/voice',async r=>{
  if(r.request().method()==='PUT'){const body=r.request().postDataJSON();puts.push(body);const names=[...new Set<string>(body.skipThinkingProviders)];config={...body,skipThinkingProviders:names.join()===builtIn.join()?undefined:names};}
  return r.fulfill({json:shown()});
 });
 await page.goto('/tests/voice-addon.html');
 const field=page.getByRole('textbox',{name:'Reply without thinking first on'});
 const reset=page.getByRole('button',{name:'Reset to the default list'});
 await expect(field).toHaveValue('llama.cpp, llama-server, llama-swap');
 await expect(reset).toBeDisabled();
 // Typed as it is, commas and all, while it is written.
 await field.fill('llama-swap, my-gateway, llama-swap, ');
 await expect(field).toHaveValue('llama-swap, my-gateway, llama-swap, ');
 await expect(reset).toBeEnabled();
 const save=page.getByRole('button',{name:'Save voice settings'}),saved=page.getByRole('button',{name:'Saved',exact:true});
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts.at(-1).skipThinkingProviders).toEqual(['llama-swap','my-gateway','llama-swap']);
 // Once saved, the list the server kept, not the text that was typed.
 await expect(field).toHaveValue('llama-swap, my-gateway');
 await reset.click();
 await expect(field).toHaveValue('llama.cpp, llama-server, llama-swap');
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts.at(-1).skipThinkingProviders).toEqual(builtIn);
 expect(config.skipThinkingProviders).toBeUndefined();
});
