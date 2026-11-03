/** Mount into the host app's existing HTTP server. */
function mountAIRoutes(router, ai) {
  router.get('/api/ai/status', (_req,res)=>res.json({ok:true,configured:ai.configured(),settings:ai.publicSettings()}));
  router.get('/api/ai/catalog', (_req,res)=>res.json({providers:ai.catalog()}));
  router.get('/api/ai/settings', (_req,res)=>res.json(ai.publicSettings()));
  router.post('/api/ai/settings', (req,res)=>{
    try { res.json({ok:true,settings:ai.saveSettings(req.body||{})}); }
    catch(e){ ai.log('error','ai.settings',{error:e.message}); res.status(400).json({ok:false,error:e.message}); }
  });
  router.get('/api/ai/models', async (_req,res)=>{
    try { res.json(await ai.refreshModels()); }
    catch(e){ ai.log('error','ai.models.refresh.fail',{error:e.message}); res.status(502).json({ok:false,error:safePublicError(e)}); }
  });
  router.post('/api/ai/test', async (_req,res)=>{
    try { res.json(await ai.testConnection()); }
    catch(e){ ai.log('error','ai.provider.test.fail',{error:e.message}); res.status(502).json({ok:false,error:safePublicError(e),code:errorCode(e)}); }
  });
  router.post('/api/ai/chat', async(req,res)=>{
    try {
      const b=req.body||{};
      if(!b.message) return res.status(400).json({ok:false,error:'message required'});
      const out=await ai.chat({message:b.message,history:Array.isArray(b.history)?b.history.slice(-8):[],context:b.context||{},knowledge:b.knowledge});
      ai.log('info','ai.chat',{provider:out.provider,model:out.model});
      res.json(out);
    } catch(e){
      ai.log('error','ai.chat.fail',{error:e.message});
      res.status(502).json({ok:false,error:safePublicError(e),code:errorCode(e)});
    }
  });
  router.get('/api/logs',(_req,res)=>res.json({logs:ai.readLogs()}));
  router.delete('/api/logs',(_req,res)=>{ai.clearLogs();res.json({ok:true});});
}
function errorCode(e){
  if(e.code==='NO_MODEL') return 'NO_MODEL';
  if(e.code==='TIMEOUT') return 'TIMEOUT';
  if(e.code==='NETWORK') return 'NETWORK_ERROR';
  if(e.code==='NOT_JSON') return 'BAD_BASE_URL';
  if(e.code==='EMPTY_RESPONSE') return 'EMPTY_RESPONSE';
  return e.status===401?'AUTH_ERROR':e.status===403?'FORBIDDEN':e.status===404?'MODEL_OR_ENDPOINT_NOT_FOUND':e.status===429?'RATE_LIMIT':'AI_PROVIDER_ERROR';
}
function safePublicError(e){
  const s=String(e?.message||e||'AI provider unavailable');
  return s.replace(/([?&](?:key|api_key|token|access_token)=[^&\s]+)/ig,'$1=[REDACTED]').replace(/Bearer\s+[^\s]+/ig,'Bearer [REDACTED]').slice(0,700);
}
module.exports={mountAIRoutes};
