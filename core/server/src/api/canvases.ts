import express from 'express';
import { getSession } from '../db.js';
import { persistCanvas, listCanvases, createCanvas, editCanvas, deleteCanvas, restoreCanvas } from '../canvases.js';
export function canvasesRouter() {
  const router=express.Router();
  router.use('/sessions/:sessionId/canvases', (req,res,next)=> {
    if(!getSession(req.params.sessionId)) return res.status(404).json({error:'Session not found'});
    next();
  });
  router.get('/sessions/:sessionId/canvases', (req,res)=>res.json(listCanvases(String(req.params.sessionId))));
  router.post('/sessions/:sessionId/canvases',(req,res)=> {
    try { if(typeof req.body?.title!=='string') throw new Error('Title required');res.json(createCanvas(String(req.params.sessionId),req.body.title)); }
    catch(e){res.status(400).json({error:(e as Error).message})}
  });
  router.post('/sessions/:sessionId/canvases/:id/persist',(req,res)=>{
    try {res.json(persistCanvas(String(req.params.sessionId),String(req.params.id)));}
    catch(e){res.status(400).json({error:(e as Error).message})}
  });
  router.put('/sessions/:sessionId/canvases/:id',(req,res)=> {
    try { const {revision,title,content}=req.body??{};if(!Number.isInteger(revision)||typeof title!=='string'||typeof content!=='string') throw new Error('Revision, title and content required');res.json(editCanvas(String(req.params.sessionId),String(req.params.id),revision,title,content)); }
    catch(e){res.status(409).json({error:(e as Error).message})}
  });
  router.post('/sessions/:sessionId/canvases/:id/restore',(req,res)=> {
    try {const revision=req.body?.revision;if(!Number.isInteger(revision)) throw new Error('Revision required');res.json(restoreCanvas(String(req.params.sessionId),String(req.params.id),revision));}
    catch(e){res.status(409).json({error:(e as Error).message})}
  });
  router.delete('/sessions/:sessionId/canvases/:id',(req,res)=> {
    try {const revision=req.body?.revision;if(!Number.isInteger(revision)) throw new Error('Revision required');deleteCanvas(String(req.params.sessionId),String(req.params.id),revision);res.json({ok:true});}
    catch(e){res.status(409).json({error:(e as Error).message})}
  });
  return router;
}
