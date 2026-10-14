import { useEffect, useRef, useState } from 'react';
import { Select } from "./Select";
import { LuFileText, LuPlus, LuX, LuTrash2, LuCheck, LuPencil, LuEye, LuSave, LuDownload, LuCopy, LuUndo2 } from 'react-icons/lu';
import { Markdown } from './Markdown';
import { asksBeforeDeleting } from '../confirm-prefs';
import { copyText } from '../clipboard';
import { canvasPictures } from '../canvas-pictures';
import { api, json } from '../api';
import { watchCanvases, type FeedState } from '../canvas-feed';
import { ResizeHandles } from './ResizeHandles';
import { t } from "../i18n";

/** How long the chat's stream may take to come up before the panel asks for the list itself. */
const STALLED_MS=2000;
type Canvas = { id:string; title:string; content:string; revision:number; status:string; active_call:string|null; updated_at:string; persisted:boolean; /** A write was cut off, and the text from before it can be put back. */ restorable?:boolean };
const request=(url:string,method:string,body?:unknown,signal?:AbortSignal)=>json<any>(url,{method,signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
export function CanvasPanel({sessionId,folder,open,setOpen}:{sessionId:string;folder:string;open:boolean;setOpen:(open:boolean)=>void}) {
  const [rows,setRows]=useState<Canvas[]>([]),[selected,setSelected]=useState('');
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(''),[title,setTitle]=useState(''),[base,setBase]=useState(0);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[feed,setFeed]=useState<FeedState>('down');
  const feedRef=useRef<FeedState>('down');
  const [confirmDelete,setConfirmDelete]=useState(false);
  /** The draft of a document that was deleted while it was being edited, kept to be copied. */
  const [lost,setLost]=useState<string|null>(null),[copied,setCopied]=useState(false);
  const editingRef=useRef(editing);editingRef.current=editing;
  const lastActiveCall=useRef<string|null>(null);
  const updates=useRef(0);
  const viewport=useRef<HTMLDivElement>(null),follow=useRef(true);
  const panel=useRef<HTMLElement>(null);
  const root=`/api/sessions/${encodeURIComponent(sessionId)}/canvases`;
  const canvas=rows.find(row=>row.id===selected);
  useEffect(()=>{
    setRows([]);setSelected('');setOpen(false);setEditing(false);setError('');setConfirmDelete(false);setLost(null);
    // Heard on the chat's own stream, which the app keeps open: see canvas-feed.ts.
    return watchCanvases(sessionId,{state:s=>{feedRef.current=s;setFeed(s);},message:(data:any)=>{
      updates.current++;
      if(data.type==='snapshot'){setRows(data.canvases);return;}
      if(data.type==='delete'){setRows(prev=>prev.filter(row=>row.id!==data.id));return;}
      const row=data.canvas as Canvas;
      setRows(prev=>[row,...prev.filter(item=>item.id!==row.id)]);
      // Follow an agent's new document unless a different canvas is being edited.
      if(data.type==='create'||data.type==='focus'||row.status==='writing'&&row.active_call!==lastActiveCall.current){lastActiveCall.current=row.active_call;if(!editingRef.current){setOpen(true);setSelected(row.id);}}
    }});
  },[sessionId]);
  // A stream that does not come up — the browser out of connections to give
  // it, or a proxy holding it — is not waited on for ever: after a moment the
  // list is asked for as if it were down.
  const [stalled,setStalled]=useState(false);
  useEffect(()=>{
    setStalled(false);
    if(feed!=='connecting')return;
    const t=setTimeout(()=>setStalled(true),STALLED_MS);
    return()=>clearTimeout(t);
  },[feed]);
  const askSelf=feed==='down'||stalled;
  // Asked for only while the stream does not carry the list — on opening, and
  // every few seconds until it does. While it does, it sent the whole list on
  // connecting and each change since, and asking as well fetched every canvas
  // twice.
  //
  // On being drawn the first ask waits a moment: the panel's effects run
  // before the app's, so it always hears "down", just before the app says it
  // is connecting.
  useEffect(()=>{
    if(!askSelf)return;
    // One ask at a time: with no connection free, each waits in the browser's
    // queue, and one every five seconds piled up to go out together.
    let disposed=false,waiting=false;const stop=new AbortController();
    const load=async()=>{if(waiting)return;waiting=true;const version=updates.current;try{const data=await request(root,'GET',undefined,stop.signal);if(!disposed&&version===updates.current){setRows(data);setError('');}}catch(e){if(!disposed)setError((e as Error).message);}finally{waiting=false;}};
    const first=setTimeout(()=>{if(stalled||feedRef.current==='down')void load();},0);const timer=setInterval(()=>void load(),5000);
    return()=>{disposed=true;stop.abort();clearTimeout(first);clearInterval(timer);};
  },[root,open,askSelf]);
  // The document being edited was deleted, by the agent or from another tab: the editor has nothing left to
  // save to, and the panel's close, picker and New canvas wait for editing to end. What was typed is kept.
  useEffect(()=>{
    if(!editing||canvas)return;
    setEditing(false);setCopied(false);
    setLost(draft.trim()?draft:null);
    setError(t("This document was deleted while you were editing it."));
  },[editing,canvas]);
  useEffect(()=>{if(!editing&&!rows.some(row=>row.id===selected))setSelected(rows[0]?.id??'');},[rows,selected,editing]);
  useEffect(()=>{if(canvas?.active_call&&follow.current&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;},[canvas?.content,canvas?.active_call]);
  const beginEdit=()=>{if(!canvas)return;setDraft(canvas.content);setTitle(canvas.title);setBase(canvas.revision);setEditing(true);setError('');};
  const save=async()=>{if(!canvas)return;setBusy(true);setError('');try{const row=await request(root+'/'+canvas.id,'PUT',{revision:base,title,content:draft});setRows(prev=>[row,...prev.filter(x=>x.id!==row.id)]);setEditing(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const create=async()=>{setBusy(true);setError('');try{const row=await request(root,'POST',{title:t('Untitled document')});setRows(prev=>[row,...prev.filter(x=>x.id!==row.id)]);setSelected(row.id);setOpen(true);setDraft('');setTitle(row.title);setBase(row.revision);setEditing(true);}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
  const remove=async()=>{if(!canvas)return;setBusy(true);try{await request(root+'/'+canvas.id,'DELETE',{revision:canvas.revision});setRows(prev=>prev.filter(x=>x.id!==canvas.id));setSelected('');setConfirmDelete(false);}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
  const store=async()=>{if(!canvas)return;setBusy(true);setError('');try{const row=await request(root+'/'+canvas.id+'/persist','POST');setRows(prev=>[row,...prev.filter(x=>x.id!==row.id)]);}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
  const restore=async()=>{if(!canvas)return;setBusy(true);setError('');try{const row=await request(root+'/'+canvas.id+'/restore','POST',{revision:canvas.revision});setRows(prev=>[row,...prev.filter(x=>x.id!==row.id)]);}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
  const download=()=>{if(!canvas)return;const url=URL.createObjectURL(new Blob([editing?draft:canvas.content],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=((editing?title:canvas.title).replace(/[\\/:*?"<>|]/g,'_')||'canvas')+'.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return <div className={`session-canvases ${open?'is-open':''}`}>
    {open&&<section ref={panel} className="canvas-panel" aria-label={t("Session canvas workspace")}>
      <header><div><LuFileText/><strong>{t("Session canvases")}</strong></div><div className="canvas-frame-actions"><button aria-label={canvas?.persisted?t("Canvas stored"):t("Store canvas")} title={canvas?.persisted?t("Stored — edits auto-save"):t("Store canvas permanently")} disabled={!canvas||canvas.persisted||busy||editing} onClick={()=>void store()}>{canvas?.persisted?<LuCheck/>:<LuSave/>}</button><button aria-label={t("Download canvas")} title={t("Download Markdown")} disabled={!canvas} onClick={download}><LuDownload/></button><button aria-label={t("Close canvas")} disabled={editing} onClick={()=>setOpen(false)}><LuX/></button></div></header>
      <div className="canvas-picker"><Select aria-label={t("Select canvas")} className="flex-1 min-w-0" size="sm" value={selected} disabled={editing} placeholder={t("Choose a document")} onChange={v=>{setSelected(v);setConfirmDelete(false);setError('');follow.current=true}} options={rows.map(row=>({value:row.id,label:row.title,text:row.title,hint:row.persisted?undefined:t("Temporary — not stored")}))}/><button disabled={editing||busy} aria-label={t("New canvas")} onClick={()=>void create()}><LuPlus/></button></div>
      {askSelf&&<p className="canvas-notice">{t("Reconnecting to live canvas…")}</p>}
      {error&&<p role="alert" className="canvas-error">{error}</p>}
      {lost!==null&&<><textarea className="canvas-editor" readOnly aria-label={t("Your draft")} value={lost}/><footer><button onClick={()=>void copyText(lost).then(ok=>ok&&setCopied(true))}>{copied?<LuCheck/>:<LuCopy/>}{copied?t("Copied"):t("Copy draft")}</button><button onClick={()=>setLost(null)}>{t("Dismiss")}</button></footer></>}
      {canvas?<>
        <div className="canvas-document-heading">{editing?<input aria-label={t("Canvas title")} maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/>:<h3>{canvas.title}</h3>}<span>{canvas.active_call?t("Writing live"):canvas.status==='edited'?t("Edited by you"):canvas.status==='interrupted'?t("Partial draft retained"):canvas.persisted?t("Auto-saved"):t("Temporary")} · {canvas.persisted?t("Stored"):t("Not stored — lost on server restart")} · r{canvas.revision}</span></div>
        {editing&&canvas.revision!==base&&<p className="canvas-error">{t("This document changed. Your draft is preserved here; copy it before cancelling to read the latest version.")}</p>}
        {editing?<textarea className="canvas-editor" aria-label={t("Edit canvas content")} value={draft} onChange={e=>setDraft(e.target.value)} spellCheck/>:<div ref={viewport} className="canvas-document prose prose-sm max-w-none" onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<60}}>{canvas.content?<Markdown>{canvasPictures(canvas.content,folder,path=>api.pictureUrl(sessionId,path))}</Markdown>:<p className="canvas-empty">{t("A blank page. Ask the agent to write here, or start editing.")}</p>}</div>}
        <footer>{editing?<><button disabled={busy||!title.trim()||canvas.revision!==base||!!canvas.active_call} onClick={()=>void save()}><LuCheck/>{canvas.persisted?t("Save changes"):t("Apply changes")}</button><button disabled={busy} onClick={()=>{setEditing(false);setError('')}}><LuEye/>{t("Cancel edit")}</button></>:<><button disabled={!!canvas.active_call||busy} onClick={beginEdit}><LuPencil/>{t("Edit inline")}</button><button disabled={!!canvas.active_call||busy} aria-label={t("Delete canvas")} onClick={()=>asksBeforeDeleting()?setConfirmDelete(true):void remove()}><LuTrash2/></button>{canvas.restorable&&!canvas.active_call&&<button disabled={busy} onClick={()=>void restore()}><LuUndo2/>{t("Restore the version before the interrupted write")}</button>}</>}{confirmDelete&&!editing&&<span className="canvas-delete-confirm">{t("Delete this document?")} <button disabled={busy} onClick={()=>void remove()}>{t("Delete")}</button><button onClick={()=>setConfirmDelete(false)}>{t("Keep")}</button></span>}</footer>
      </>:<div className="canvas-empty"><LuFileText/><h3>{t("A place for your documents")}</h3><p>{t("Ask the agent to create a canvas, or start a document here.")}</p><button disabled={busy} onClick={()=>void create()}>{t("Create canvas")}</button></div>}
    <ResizeHandles target={panel} mode="anchored" edges={["w","s","sw"]}/></section>}
  </div>;
}
