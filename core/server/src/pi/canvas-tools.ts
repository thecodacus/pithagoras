import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { listCanvases,focusCanvas,readCanvas,markCanvasRead,createCanvas,deleteCanvas,beginCanvasWrite,saveCanvasPrefix,finishCanvasWrite } from '../canvases.js';
import { GATEWAY_TOOL, calledThrough } from './tools-gateway-names.js';
import { oneOf } from './tool-schema.js';

/** Decode only complete JSON escape sequences; an unfinished escape stays pending. */
function stringPrefix(raw: string,start: number): {value:string;end:number;complete:boolean} {
  let value='',i=start+1;
  for(;i<raw.length;i++) {
    const c=raw[i];if(c==='"')return {value,end:i+1,complete:true};
    if(c==='\\') {
      const next=raw[i+1];if(!next)break;
      const size=next==='u'?6:2;if(i+size>raw.length)break;
      try{value+=JSON.parse('"'+raw.slice(i,i+size)+'"')}catch{break} i+=size-1;
    } else {if(c.charCodeAt(0)<32)break;value+=c;}
  }
  // Do not persist half of a Unicode surrogate pair.
  if(/[\uD800-\uDBFF]$/.test(value)) value=value.slice(0,-1);
  return {value,end:i,complete:false};
}
/** The start of a write's arguments is a few short values; one that is longer than this is not a write we follow. */
const MAX_HEAD=4096;
/** The arguments before the content string: what is in them, and where the content's text begins. */
function readHead(raw: string): {args:Record<string,any>;at:number} | undefined {
  let i=0;const args:Record<string,any>={}; const ws=()=>{while(/\s/.test(raw[i]??'')&&i<raw.length)i++};
  ws();if(raw[i++]!=='{')return;
  while(i<raw.length){ws();if(raw[i]!== '"')return;const key=stringPrefix(raw,i);if(!key.complete)return;i=key.end;ws();if(raw[i++]!==':')return;ws();
    if(raw[i]==='"'){
      if(key.value==='content')return {args,at:i+1};
      const v=stringPrefix(raw,i);if(!v.complete)return;args[key.value]=v.value;i=v.end;
    }else{const n=/^\d+(?=\s*[,}])/.exec(raw.slice(i));if(!n)return;args[key.value]=Number(n[0]);i+=n[0].length;}
    ws();if(raw[i++]!==',')return;
  }
}
/**
 * The arguments of one canvas_write call as they stream in, decoded as far as
 * they have come. Each piece is looked at once, when it arrives: decoding the
 * whole argument again for every piece cost a quadratic amount of work, and a
 * long document kept the server busy for as long as it was being written.
 */
export class WriteStream {
  private head='';
  private args?:Record<string,any>;
  private text='';
  /** The start of an escape that has not come in whole yet. */
  private pending='';
  /** Half of a Unicode surrogate pair is not saved until the other half comes. */
  private high='';
  private closed=false;
  /** Something that is not JSON: what came before it is kept, and nothing after it is read. */
  private stuck=false;
  private dead=false;
  push(delta: string): Record<string,any> | undefined {
    if(this.dead)return;
    if(!this.args) {
      this.head+=delta;
      const found=readHead(this.head);
      if(!found) {if(this.head.length>MAX_HEAD){this.dead=true;this.head='';}return;}
      this.args=found.args;delta=this.head.slice(found.at);this.head='';
    }
    this.decode(delta);
    return {...this.args,content:this.text};
  }
  private decode(chunk: string) {
    if(this.closed||this.stuck)return;
    const s=this.pending+chunk;this.pending='';
    let out='',run=0,stopped=false;
    for(let i=0;i<s.length&&!stopped;i++) {
      const c=s.charCodeAt(i);
      if(c>31&&c!==34&&c!==92)continue;
      out+=s.slice(run,i);
      if(c===34)this.closed=true;
      else if(c!==92)this.stuck=true;
      else {
        const size=s[i+1]==='u'?6:2;
        if(i+size>s.length)this.pending=s.slice(i);
        else {
          try{out+=JSON.parse('"'+s.slice(i,i+size)+'"');run=i+size;i+=size-1;continue}catch{this.stuck=true}
        }
      }
      stopped=true;
    }
    if(!stopped)out+=s.slice(run);
    out=this.high+out;this.high='';
    const last=out.charCodeAt(out.length-1);
    if(last>=0xD800&&last<=0xDBFF){this.high=out.slice(-1);out=out.slice(0,-1);}
    this.text+=out;
    // A string that was closed is whole, whatever it ends in.
    if(this.closed){this.text+=this.high;this.high='';}
  }
}
/** How far the start of a call through the `tools` tool is read: what is before its `args`. */
type GatewayHead={at:number;text:boolean} | 'more' | 'dead';
/**
 * The start of `{"action":"call","name":"canvas_write","args":…`: the strings before `args`, and where the
 * arguments begin, as an object or as the text of one. 'more' where it has not come far enough to tell, 'dead' where
 * it is not a write we can follow: another action or tool, or `args` before them.
 */
function readGatewayHead(raw: string): GatewayHead {
  let i=0;const seen:Record<string,string>={};const ws=()=>{while(/\s/.test(raw[i]??'')&&i<raw.length)i++};
  ws();if(i>=raw.length)return 'more';if(raw[i++]!=='{')return 'dead';
  while(true){
    ws();if(i>=raw.length)return 'more';if(raw[i]!=='"')return 'dead';
    const key=stringPrefix(raw,i);if(!key.complete)return 'more';i=key.end;
    ws();if(i>=raw.length)return 'more';if(raw[i++]!==':')return 'dead';
    ws();if(i>=raw.length)return 'more';
    if(key.value==='args'){
      if(seen.action!=='call'||seen.name!=='canvas_write')return 'dead';
      return raw[i]==='{'?{at:i,text:false}:raw[i]==='"'?{at:i+1,text:true}:'dead';
    }
    if(raw[i]!=='"')return 'dead';
    const v=stringPrefix(raw,i);if(!v.complete)return 'more';seen[key.value]=v.value;i=v.end;
    ws();if(i>=raw.length)return 'more';if(raw[i++]!==',')return 'dead';
  }
}
/**
 * A canvas_write that is called through the `tools` tool, as it streams in: the same write as WriteStream follows,
 * with its arguments nested in `args` — an object, or the JSON text of one, which is then in a string that is
 * decoded as it comes. Followed only when `name` comes before `args`, as the tool's schema has them: else
 * nothing is known of the call until its text is all there, and it is written when the tool runs.
 */
export class GatewayWriteStream {
  private head='';
  private inner=new WriteStream();
  private mode:'head'|'object'|'text'|'dead'='head';
  /** The start of an escape of the text that has not come in whole yet. */
  private pending='';
  private ended=false;
  push(delta: string): Record<string,any> | undefined {
    if(this.mode==='dead')return;
    if(this.mode==='head') {
      this.head+=delta;
      const found=readGatewayHead(this.head);
      if(found==='more'){if(this.head.length>MAX_HEAD){this.mode='dead';this.head='';}return;}
      if(found==='dead'){this.mode='dead';this.head='';return;}
      delta=this.head.slice(found.at);this.head='';this.mode=found.text?'text':'object';
    }
    const raw=this.mode==='text'?this.unquote(delta):delta;
    if((this.mode as string)==='dead'||!raw)return;
    return this.inner.push(raw);
  }
  /** The text of a JSON string as far as it has come: its escapes decoded, an unfinished one kept for the next piece. */
  private unquote(chunk: string): string {
    if(this.ended)return '';
    const s=this.pending+chunk;this.pending='';
    let out='',run=0;
    for(let i=0;i<s.length;i++) {
      const c=s.charCodeAt(i);
      if(c>31&&c!==34&&c!==92)continue;
      out+=s.slice(run,i);
      if(c===34){this.ended=true;return out;}
      if(c!==92){this.mode='dead';return out;}
      const size=s[i+1]==='u'?6:2;
      if(!s[i+1]||i+size>s.length){this.pending=s.slice(i);return out;}
      try{out+=JSON.parse('"'+s.slice(i,i+size)+'"')}catch{this.mode='dead';return out}
      i+=size-1;run=i+1;
    }
    return out+s.slice(run);
  }
}
export function canvasWritePrefix(raw: string): Record<string,any> | undefined {
  return new WriteStream().push(raw);
}
type Write={id:string;base:string;revision:number;operation:string;content:string};
export class CanvasTools {
  private writes=new Map<string,Write>();
  private streams=new Map<string,WriteStream|GatewayWriteStream>();
  private errors=new Map<string,string>();
  /**
   * Whether canvas_write is called through the `tools` tool now, which is when a call of that is a write to follow. A
   * call through it of a tool that is not lazy is refused, and nothing it carries is written.
   */
  viaGateway:()=>boolean=()=>false;
  /**
   * Whether canvas_write is offered to the model by its own name now. A call of it by that name when it is not (it is lazy, or
   * switched off) is answered "not found" and never runs, so the text it carries is nobody's to write.
   */
  direct:()=>boolean=()=>true;
  constructor(private session:string){}
  private apply(call:string,p:any) {
    if(typeof p?.canvas_id!=='string'||!Number.isInteger(p.revision)||!['replace','append'].includes(p.operation)||typeof p.content!=='string')return;
    if(this.errors.has(call))throw new Error(this.errors.get(call));
    let write=this.writes.get(call);
    if(!write){const row=beginCanvasWrite(this.session,p.canvas_id,p.revision,call);write={id:row.id,base:row.content,revision:p.revision,operation:p.operation,content:''};this.writes.set(call,write);}
    if(write.id!==p.canvas_id||write.revision!==p.revision||write.operation!==p.operation)throw new Error('Write metadata changed mid-stream; partial draft retained');
    saveCanvasPrefix(this.session,write.id,call,(write.operation==='append'?write.base:'')+p.content);
    write.content=p.content;
  }
  observe(event:any) {
    const inner=event.assistantMessageEvent;
    if(event.type==='message_update'&&inner?.type==='toolcall_delta') {
      const tool=inner.partial?.content?.[inner.contentIndex];
      if(!tool?.id)return;
      let stream=this.streams.get(tool.id);
      if(!stream) {
        // Called as it is, or through the `tools` tool where it is lazy: the same text, one level further in.
        if(tool.name==='canvas_write'&&this.direct())stream=new WriteStream();
        else if(tool.name===GATEWAY_TOOL&&this.viaGateway())stream=new GatewayWriteStream();
        else return;
        this.streams.set(tool.id,stream);
      }
      const p=stream.push(inner.delta);if(!p || !p.content)return;
      try{this.apply(tool.id,p)}catch(e){this.errors.set(tool.id,(e as Error).message);this.finish(tool.id,true);}
    }
    // The call is whole now, and what runs is what JSON makes of it: the last of a key given twice. A call of the `tools` tool
    // that is not a canvas_write after all leaves the text that was written on its way out of the document.
    if(event.type==='tool_execution_start'&&event.toolName===GATEWAY_TOOL&&calledThrough(event.args)?.name!=='canvas_write')this.discard(event.toolCallId);
    if(event.type==='tool_execution_end') {
      if(event.isError)this.finish(event.toolCallId,true);
      // A call through the `tools` tool that was no write leaves its stream behind.
      this.streams.delete(event.toolCallId);
    }
    if(event.type==='agent_end'||event.type==='agent_settled'||event.type==='message_end'&&['aborted','error'].includes(event.message?.stopReason))this.interrupt();
  }
  /** A write that turned out to be no canvas_write: the document is as it was before it, and nothing is left open. */
  private discard(call:string) {
    const w=this.writes.get(call);
    if(w) {
      try{saveCanvasPrefix(this.session,w.id,call,w.base)}catch{/* the write is over either way */}
      finishCanvasWrite(this.session,w.id,call,false);
    }
    this.writes.delete(call);this.streams.delete(call);this.errors.delete(call);
  }
  private finish(call:string,partial:boolean){const w=this.writes.get(call);if(w)finishCanvasWrite(this.session,w.id,call,partial);this.writes.delete(call);this.streams.delete(call);}
  interrupt(){for(const call of this.writes.keys())this.finish(call,true);this.streams.clear();this.errors.clear();}
  extension=(pi:ExtensionAPI)=>{
    const register=(name:string,description:string,parameters:any,execute:(id:string,p:any)=>any)=>pi.registerTool({name,label:name.replaceAll('_',' '),description,parameters,execute:async(id:string,p:any)=>{const result=execute(id,p);return {content:[{type:'text',text:JSON.stringify(result)}],details:result}}});
    register('canvas_list','List this chat’s canvases, temporary and stored.',Type.Object({}),()=>listCanvases(this.session).map(({content,active_call,...row})=>({...row,characters:content.length})));
    register('canvas_create','Open an empty document canvas beside the chat, to fill with canvas_write. It is temporary until the person stores it.',Type.Object({title:Type.String()}),(_id,p)=>{const row=createCanvas(this.session,p.title);return markCanvasRead(this.session,row.id)});
    register('canvas_read','Read a canvas and its revision, with any text kept from an interrupted write. canvas_id is the id from canvas_list or canvas_create, not the title.',Type.Object({canvas_id:Type.String()}),(_id,p)=>{const row=markCanvasRead(this.session,p.canvas_id);focusCanvas(this.session,row.id);return row});
    register('canvas_write','Write a canvas live: text is saved as it streams, so an interrupted write keeps what came. Arguments in this order, content last: canvas_id, revision, operation, content. revision: from your last canvas result; read first only for an unread canvas or after the person edited it. operation: replace the document or append to it. Markdown, with pictures from the chat\'s folder: ![caption](relative/path.png).',Type.Object({canvas_id:Type.String(),revision:Type.Integer(),operation:oneOf(['replace','append']),content:Type.String()}),(id,p)=>{
      try {this.apply(id,p);const row=readCanvas(this.session,p.canvas_id);this.finish(id,false);return {id:row.id,revision:row.revision,characters:row.content.length,saved:row.persisted,persisted:row.persisted};}
      catch(e){this.finish(id,true);throw e;}
    });
    register('canvas_delete','Delete a canvas, only when the person asks. revision: the current one.',Type.Object({canvas_id:Type.String(),revision:Type.Integer()}),(_id,p)=>{deleteCanvas(this.session,p.canvas_id,p.revision);return {deleted:true}});
  };
}
