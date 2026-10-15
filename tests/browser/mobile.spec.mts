import { test, expect, mockPortal } from './portal-mock';
test('phone can send, open workspace navigation, and scroll slash commands without page overflow',async({page})=>{
 await page.setViewportSize({width:375,height:812});
 const session={id:'mobile',title:'Mobile session',workspace:'/workspaces/demo',status:'idle',kind:'task',pinned:false};let submitted='';
 await mockPortal(page,({path:p,json})=>{
  if(p==='/api/sessions')return{sessions:[session],executor:'host'};
  if(p===`/api/sessions/${session.id}`)return session;
  if(p==='/api/workspaces')return{root:'/workspaces',workspaces:[{name:'demo',path:'/workspaces/demo',isGit:false}]};
  if(p.endsWith('/commands'))return{commands:Array.from({length:10},(_,i)=>({name:`cmd${i}`,description:'A command',source:'extension'}))};
  if(p.endsWith('/config'))return{live:false,state:{model:{id:'test',name:'Test',provider:'local'},thinkingLevel:'medium'},stats:null,thinking:{levels:[]},models:{models:[]}};
  if(p.endsWith('/prompt')){submitted=json().message;return{ok:true};}
 });
 await page.addInitScript(()=>localStorage.setItem('sidebarCollapsed','true'));
 await page.goto('/s/mobile');
 await page.getByLabel('Message',{exact:true}).fill('Hello from a phone');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect.poll(()=>submitted).toBe('Hello from a phone');
 await expect(page.getByLabel('Sidebar',{exact:true})).toBeHidden();
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await expect(page.getByLabel('Sidebar',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Sidebar',{exact:true}).getByText('Mobile session').first()).toBeVisible();
 await expect(page.getByLabel('Sidebar',{exact:true}).getByText('/workspaces/demo')).toHaveCount(0);
 await page.getByLabel('Close navigation',{exact:true}).click();
 const dimensions=await page.evaluate(()=>({w:document.body.scrollWidth,h:document.body.scrollHeight,vw:innerWidth,vh:innerHeight,font:getComputedStyle(document.querySelector('.prompt-input')!).fontSize}));
 expect(dimensions.w).toBeLessThanOrEqual(dimensions.vw);expect(dimensions.h).toBeLessThanOrEqual(dimensions.vh);expect(dimensions.font).toBe('16px');
 await page.setViewportSize({width:375,height:500});await page.getByLabel('Message',{exact:true}).fill('/cmd');
 const menu=page.locator('.prompt-shell > .absolute');await expect(menu).toBeVisible();
 expect(await menu.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true);
 await menu.evaluate(e=>e.scrollTop=e.scrollHeight);expect(await menu.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
});
