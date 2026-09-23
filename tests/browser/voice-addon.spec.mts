import {test,expect} from '@playwright/test';
test('settings install progress, ready connection, and stop',async({page})=>{
 let state='absent'; const actions:string[]=[];
 const config={enabled:false,whisperUrl:'http://127.0.0.1:8178/inference',breezeUrl:'http://127.0.0.1:7860/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'breeze',language:'auto',cfgScale:4};
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:state==='running'}}));
 await page.route('**/api/voice/install',async r=>{
  if(r.request().method()==='POST'){actions.push('install');state='starting';return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:state==='starting'?'Quantizing Breeze to Q8_0 on CPU':'',error:''}});
 });
 await page.route('**/api/voice/stop',r=>{actions.push('stop');state='stopped';return r.fulfill({json:{ok:true}});});
 await page.goto('/tests/voice-addon.html');
 await expect(page.getByLabel('Speech recognition URL')).toBeHidden();
 await page.locator('summary').filter({hasText:'Voice service'}).click();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect(page.getByLabel('Voice setup log')).toContainText('Quantizing');
 await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeDisabled();
 state='running';
 await expect(page.getByRole('checkbox',{name:'Enable voice controls in sessions'})).toBeChecked({timeout:8000});
 await page.getByRole('button',{name:'Stop · release VRAM'}).click();
 await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeEnabled();
 expect(actions).toEqual(['install','stop']);
 await page.screenshot({path:'/tmp/pithagoras-voice-addon.png'});
});

test('speech detection settings save and restore defaults',async({page})=>{
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'aria',runtime:'audio-cpp'};
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false}}));
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
 await page.screenshot({path:'/tmp/pithagoras-vad-settings.png'});
});
