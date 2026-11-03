/**
 * Universal SoloHost Feedback Hub server module.
 * IMPORTANT: token never leaves this server.
 */
'use strict';
const DEFAULTS={
  hubId:'SHFH-CANNOI-0905428801',
  baseUrl:'http://14.176.78.46:8090',
  ingestToken:'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9'
};
function createFeedbackService(opts={}){
  const cfg={...DEFAULTS,...opts};
  const appId=opts.appId||process.env.SHFH_APP_ID||'app';
  const appName=opts.appName||process.env.SHFH_APP_NAME||'Application';
  const version=opts.version||process.env.SHFH_APP_VERSION||'1.0.0';
  const base=String(cfg.baseUrl).replace(/\/$/,'');
  async function request(method,path,body){
    const headers={'Accept':'application/json'};
    if(method!=='GET') {headers['Content-Type']='application/json';headers.Authorization='Bearer '+cfg.ingestToken;}
    const r=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error||`Feedback Hub HTTP ${r.status}`);
    return j;
  }
  function publicConfig(){return {enabled:true,hubId:cfg.hubId,appId,appName,version};}
  async function sync(anonymousId){
    const q=`?app_id=${encodeURIComponent(appId)}&version=${encodeURIComponent(version)}`;
    const nq=`?app_id=${encodeURIComponent(appId)}&anonymous_id=${encodeURIComponent(anonymousId||'')}`;
    const [policy,notices]=await Promise.all([
      request('GET','/api/client-policy'+q),
      request('GET','/api/notices'+nq)
    ]);
    return {ok:true,policy,notices:notices.items||[],donate:policy.donate||null};
  }
  async function send(payload){ return request('POST','/api/feedback',payload); }
  async function markRead(id){ return request('POST','/api/notices/'+encodeURIComponent(id)+'/read',{}); }
  return {publicConfig,sync,send,markRead,appId,appName,version};
}
function mountFeedbackRoutes(router,fb){
  router.get('/api/feedback/config',(_req,res)=>res.json(fb.publicConfig()));
  router.get('/api/feedback/sync',async(req,res)=>{
    try{res.json(await fb.sync(String(req.query.anonymous_id||'')));}
    catch(e){res.status(502).json({ok:false,error:'Feedback Hub unavailable'});}
  });
  router.post('/api/feedback',async(req,res)=>{
    try{
      const b=req.body||{};
      const safe={...b,app_id:fb.appId,app_name:fb.appName,version:fb.version};
      delete safe.apiKey; delete safe.token; delete safe.password;
      res.json(await fb.send(safe));
    }catch(e){res.status(502).json({ok:false,error:'Feedback Hub unavailable'});}
  });
  router.post('/api/feedback/read/:id',async(req,res)=>{
    try{res.json(await fb.markRead(req.params.id));}catch{res.status(502).json({ok:false});}
  });
}
module.exports={createFeedbackService,mountFeedbackRoutes,DEFAULTS};
