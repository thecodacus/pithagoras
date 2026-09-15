import {test,expect} from '@playwright/test';
test('phone can send, open workspace navigation, and scroll slash commands without page overflow',async({page})=>{
 await page.setViewportSize({width:375,height:812});
 const session={id:'mobile',title:'Mobile session',workspace:'/workspaces/demo',status:'idle',kind:'task',pinned:false};let submitted='';
 await page.route('**/api/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  const value=p.endsWith('/auth/status')?{authed:true}:p==='/api/sessions'?{sessions:[session],executor:'host'}:p==='/api/workspaces'?{root:'/workspaces',workspaces:[{name:'demo',path:'/workspaces/demo',isGit:false}]}:p.endsWith('/commands')?{commands:Array.from({length:10},(_,i)=>({name:`cmd${i}`,description:'A command',source:'extension'}))}:p.endsWith('/config')?{live:false,state:{model:{id:'test',name:'Test',provider:'local'},thinkingLevel:'medium'},stats:null,thinking:{levels:[]},models:{models:[]}}:p==='/api/browser'?{running:false,sessions:[],routines:[]}:p.endsWith('/canvases')?[]:p==='/api/voice'?{enabled:false}:p.endsWith('/prompt')?(submitted=route.request().postDataJSON().message,{ok:true}):session;
  await route.fulfill({json:value});
 });
 await page.addInitScript(()=>{(window as any).EventSource=class {onmessage:any;onopen:any;onerror:any;addEventListener(){}close(){}};localStorage.setItem('sidebarCollapsed','true');});
 await page.goto('/s/mobile');
 await page.getByLabel('Message',{exact:true}).fill('Hello from a phone');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect.poll(()=>submitted).toBe('Hello from a phone');
 await expect(page.getByLabel('Sidebar',{exact:true})).toBeHidden();
 await page.getByLabel('Open navigation',{exact:true}).click();
 await expect(page.getByLabel('Sidebar',{exact:true})).toBeVisible();
 await expect(page.getByText('demo',{exact:true}).first()).toBeVisible();
 await page.getByLabel('Close navigation',{exact:true}).click();
 const dimensions=await page.evaluate(()=>({w:document.body.scrollWidth,h:document.body.scrollHeight,vw:innerWidth,vh:innerHeight,font:getComputedStyle(document.querySelector('.prompt-input')!).fontSize}));
 expect(dimensions.w).toBeLessThanOrEqual(dimensions.vw);expect(dimensions.h).toBeLessThanOrEqual(dimensions.vh);expect(dimensions.font).toBe('16px');
 await page.setViewportSize({width:375,height:500});await page.getByLabel('Message',{exact:true}).fill('/cmd');
 const menu=page.locator('.prompt-shell > .absolute');await expect(menu).toBeVisible();
 expect(await menu.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true);
 await menu.evaluate(e=>e.scrollTop=e.scrollHeight);expect(await menu.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
 await page.screenshot({path:'/tmp/pithagoras-mobile-issue3.png'});
});
