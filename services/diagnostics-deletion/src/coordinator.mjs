import {validatePublicJwk,jwkThumbprint} from './auth.mjs';
import {isStrictTimestamp} from './providers.mjs';
const NAMES=['analytics','crashlytics'];
const DAY=86400000;
export class ApiError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function fail(status,code){throw new ApiError(status,code);}
const iso=time=>new Date(time).toISOString();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function exact(value,required,optional=[]){return object(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));}
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const kidPattern=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{20,128}$/.test(value);
const states={futureTelemetry:['disabled_persisted','restart_required','sdk_unavailable'],analyticsLocal:['pending','reset_requested','unavailable','failed'],crashlyticsLocal:['pending','restart_required','delete_queued','no_unsent_reports_observed','unavailable','failed']};
function clientState(value){return exact(value,Object.keys(states))&&Object.entries(states).every(([k,allowed])=>allowed.includes(value[k]));}
function providerTarget(name,config){return name==='analytics'?{propertyId:config.google.analyticsPropertyId}:{projectNumber:config.google.crashlyticsProjectNumber,appId:config.google.crashlyticsAppId};}
function fingerprint(body){return JSON.stringify([body.epochId,body.intent,body.policyVersion]);}
export function json(body,status=200,extra={}){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});}
export function errorResponse(error){return json({error:{code:error instanceof ApiError?error.code:'temporarily_unavailable'}},error instanceof ApiError?error.status:503);}
export async function readBody(request,maxBytes,timeoutMs){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail(503,'not_configured');
 const reader=request.body?.getReader();if(!reader)return {text:'',bytes:new Uint8Array()};
 let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new ApiError(503,'temporarily_unavailable'));},timeoutMs);});
 const reading=(async()=>{
  const chunks=[];let count=0;
  try{for(;;){const p=await reader.read();if(p.done)break;count+=p.value.byteLength;if(count>maxBytes){void reader.cancel().catch(()=>{});fail(413,'payload_too_large');}chunks.push(p.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(count);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),bytes};}catch{fail(400,'invalid_request');}
 })();
 try{return await Promise.race([timeout,reading]);}finally{clearTimeout(timer);}
}
function parse(text){try{return JSON.parse(text);}catch{fail(400,'invalid_request');}}
function challengeId(proof){
 if(typeof proof!=='string'||proof.length>8192)fail(401,'invalid_proof');
 try{const parts=proof.split('.');if(parts.length!==3||! /^[A-Za-z0-9_-]+$/.test(parts[1]))fail(401,'invalid_proof');
 const b=parts[1].replaceAll('-','+').replaceAll('_','/');const claims=JSON.parse(atob(b+'='.repeat((4-b.length%4)%4)));
 if(!identifier(claims.challengeId))fail(401,'invalid_proof');return claims.challengeId;}catch{fail(401,'invalid_proof');}
}
function needsAttestation(method,path){return method==='POST'&&['/v1/enrollments','/v1/requests'].includes(path);}
function validTarget(method,path){return (method==='POST'&&['/v1/enrollments','/v1/requests'].includes(path))||(method==='GET'&&/^\/v1\/requests\/[0-9a-f-]{36}$/.test(path))||(method==='POST'&&/^\/v1\/requests\/[0-9a-f-]{36}\/client-state$/.test(path));}
function restartRequired(local){return ['pending','restart_required','failed'].includes(local.crashlyticsLocal);}
function providerReady(record,name){
 const local=record.clientState;
 return local.futureTelemetry==='disabled_persisted'&&(name==='analytics'
  ?local.analyticsLocal==='reset_requested'
  :['delete_queued','no_unsent_reports_observed'].includes(local.crashlyticsLocal));
}
function settled(record){return NAMES.every(n=>record.providers[n].state==='submitted'&&!record.providers[n].additionalSubmissionRequired)&&record.clientState.futureTelemetry==='disabled_persisted'&&record.clientState.analyticsLocal==='reset_requested'&&['delete_queued','no_unsent_reports_observed'].includes(record.clientState.crashlyticsLocal);}
function publicReceipt(record){
 const providers={};for(const name of NAMES){const job=record.providers[name];providers[name]={state:job.state,completionEvidence:job.state==='submitted'?'submission_only':'none'};
 for(const key of ['deletionRequestTime','targetCompleteTime','nextRetryAt','errorCode','additionalSubmissionRequired'])if(job[key]!==undefined)providers[name][key]=job[key];}
 const values=NAMES.map(n=>record.providers[n]);const state=values.some(j=>j.state==='operator_action_required'||j.additionalSubmissionRequired)?'operator_action_required':values.every(j=>j.state==='submitted')?'provider_submitted':values.some(j=>j.state==='retry_wait')?'retrying':'accepted';
 return {schemaVersion:1,requestId:record.requestId,acceptedAt:record.acceptedAt,state,providers:{...providers,mlkit:{state:'unsupported'}},legacyCoverage:'not_covered',exportCopies:'not_verified',completionEvidence:values.some(j=>j.state==='submitted')?'submission_only':'none',clientContinuation:restartRequired(record.clientState)?'restart_required':'none',clientState:record.clientState};
}
function scheduling(state,config,now){
 const times=Object.values(state.challenges).map(c=>c.expiresAt);
 if(state.mappingPurgeAt!==null&&state.mappingPurgeAt!==undefined)times.push(state.mappingPurgeAt);
 if(state.receipt){for(const [name,job] of Object.entries(state.receipt.providers)){if(!providerReady(state.receipt,name))continue;if(job.state==='in_flight')times.push(job.leaseUntil);if(['queued','retry_wait'].includes(job.state))times.push(job.nextAt);}
 if(settled(state.receipt)){state.receipt.settledAt??=now;times.push(state.receipt.settledAt+state.receipt.retention.receiptDays*DAY);}}
 state.alarmAt=times.length?Math.min(...times):null;
}
function prune(state,config,now){
 for(const [key,value] of Object.entries(state.challenges))if(value.expiresAt<=now)delete state.challenges[key];
 if(state.receipt&&settled(state.receipt)&&state.receipt.settledAt!==undefined&&state.receipt.settledAt+state.receipt.retention.receiptDays*DAY<=now){
  state.mappingPurgeAt=state.receipt.settledAt+state.receipt.retention.mappingDays*DAY;
  state.receipt=null;
 }
 if(state.mappingPurgeAt!==null&&state.mappingPurgeAt!==undefined&&state.mappingPurgeAt<=now){
  state.epoch=null;state.retired=true;state.challenges={};state.mappingPurgeAt=null;
  // Keep only the explicitly approved retired-key tombstone, with no ID mapping.
 }
 scheduling(state,config,now);
}
export function createRandomIds(cryptoObject=globalThis.crypto){
 return label=>{const bytes=new Uint8Array(32);cryptoObject.getRandomValues(bytes);let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return `${label}_${btoa(binary).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}`;};
}
function safeAdapter(name,result,now,config){
 const invalid={state:'operator_action_required',completionEvidence:'none',errorCode:'adapter_invalid_result'};
 const known=new Set(['rate_limited','provider_timeout','provider_unavailable','provider_authentication_required','provider_permission_denied','provider_request_rejected','invalid_provider_response','invalid_provider_json','invalid_provider_timestamp','invalid_retry_schedule','token_unavailable','provider_not_configured','adapter_unavailable','not_configured','invalid_target','permission_verification_required','invalid_attempt','invalid_clock','unsupported_provider']);
 const date=isStrictTimestamp;
 if(result?.state==='submitted'){const key=name==='analytics'?'deletionRequestTime':'targetCompleteTime';if(!exact(result,['state','completionEvidence',key])||result.completionEvidence!=='submission_only'||!date(result[key]))return invalid;return {state:'submitted',completionEvidence:'submission_only',[key]:result[key]};}
 if(result?.state==='retry_wait'&&exact(result,['state','completionEvidence','errorCode','nextRetryAt'])&&known.has(result.errorCode)&&result.completionEvidence==='none'&&date(result.nextRetryAt))return {...result,nextAt:Math.max(now+1000,Date.parse(result.nextRetryAt))};
 if(result?.state==='operator_action_required'&&exact(result,['state','completionEvidence','errorCode'])&&known.has(result.errorCode)&&result.completionEvidence==='none')return {state:result.state,completionEvidence:'none',errorCode:result.errorCode};
 return invalid;
}
/** Production coordinator; dependencies are actual storage/auth/provider APIs.
 * Tests inject fixed identities and network/storage fixtures without real calls. */
export function createDeletionService({config,store,auth,providers,ids=createRandomIds(),now=()=>Date.now(),ownerKey,crypto=globalThis.crypto}){
 const enabled=config?.enabled===true&&config.googleAdapterMode==='live'&&config.google?.crashlyticsIamVerified===true&&config.retention?.retiredKeyPolicy==='retain_tombstone';
 const capabilities=()=>({schemaVersion:1,platforms:['android'],enrollmentEnabled:enabled,remoteDeletionEnabled:enabled,providers:{analytics:enabled?'configured':'not_configured',crashlytics:enabled?'configured':'permission_verification_required',mlkit:'unsupported'},legacyDeletion:'not_automated',remoteCompletionEvidence:'submission_only'});
 async function attestation(request){const result=await auth.verifyAppCheck(request.headers.get('X-Firebase-AppCheck'));if(!result.ok)fail(result.status??403,result.code??'app_attestation_rejected');return result;}
 async function fetch(request){try{
  const url=new URL(request.url);if(url.search)fail(400,'invalid_request');
  if(url.pathname==='/v1/capabilities'&&request.method==='GET')return json(capabilities());
  if(!enabled)fail(503,'not_configured');
  const kid=request.headers.get('Ponlet-Privacy-Key');if(!kidPattern(kid)||kid!==ownerKey)fail(401,'invalid_proof');
  if(request.method==='POST'&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''))fail(400,'invalid_request');
  const {text,bytes}=await readBody(request,config.limits.maxBodyBytes,config.limits.bodyReadTimeoutMs);const body=request.method==='POST'?parse(text):null;
  if(url.pathname==='/v1/challenges'&&request.method==='POST'){
   if(!exact(body,['schemaVersion','kid','method','path'],['publicJwk'])||body.schemaVersion!==1||body.kid!==kid||!validTarget(body.method,body.path))fail(400,'invalid_request');
   const enrollment=body.path==='/v1/enrollments';
   if(enrollment&&(!validatePublicJwk(body.publicJwk)||await jwkThumbprint(body.publicJwk,crypto)!==kid))fail(400,'invalid_request');
   if(!enrollment&&Object.hasOwn(body,'publicJwk'))fail(400,'invalid_request');
   if(needsAttestation(body.method,body.path))await attestation(request);
   const challenge=await store.transaction(state=>{
    state.recoveryDelayMs=config.google.retryMaxMs;
    prune(state,config,now());
    if(state.challengeWindow.startedAt+config.limits.challengeWindowMs<=now())state.challengeWindow={startedAt:now(),count:0};
    if(state.challengeWindow.count>=config.limits.maxChallengesPerWindow||Object.keys(state.challenges).length>=config.limits.maxChallenges)fail(429,'rate_limited');
    const challengeId=ids('chg'),nonce=ids('nonce');if(!identifier(challengeId)||!identifier(nonce)||state.challenges[challengeId])fail(503,'identity_generation_failed');
    const value={challengeId,nonce,ownerKey:kid,method:body.method,path:body.path,expiresAt:now()+config.retention.nonceTtlSeconds*1000};
    state.challenges[challengeId]=value;state.challengeWindow.count++;scheduling(state,config,now());return value;
   });return json(challenge,201);
  }
  const enrollment=url.pathname==='/v1/enrollments'&&request.method==='POST';
  const create=url.pathname==='/v1/requests'&&request.method==='POST';
  const match=url.pathname.match(/^\/v1\/requests\/([0-9a-f-]{36})(\/client-state)?$/);const read=match&&!match[2]&&request.method==='GET';const update=match&&match[2]&&request.method==='POST';
  if(!enrollment&&!create&&!read&&!update)fail(404,'not_found');if(request.method==='GET'&&text)fail(400,'invalid_request');
  if(enrollment&&(!exact(body,['schemaVersion','enrollmentRequestId','platform','publicJwk'])||body.schemaVersion!==1||!uuid(body.enrollmentRequestId)||body.platform!=='android'||!validatePublicJwk(body.publicJwk)))fail(400,'invalid_request');
  if(create&&(!exact(body,['schemaVersion','requestId','epochId','intent','policyVersion','clientState'])||body.schemaVersion!==1||!uuid(body.requestId)||!identifier(body.epochId)||typeof body.intent!=='string'||typeof body.policyVersion!=='string'||!clientState(body.clientState)))fail(400,'invalid_request');
  if(update&&(!exact(body,['schemaVersion','clientState'])||body.schemaVersion!==1||!clientState(body.clientState)))fail(400,'invalid_request');
  const token=request.headers.get('Ponlet-Privacy-Proof'),cid=challengeId(token),prior=await store.read(),challenge=prior.challenges[cid];
  if(!challenge||challenge.expiresAt<=now())fail(401,'expired_challenge');
  const publicJwk=enrollment?body.publicJwk:prior.epoch?.publicJwk;if(!publicJwk)fail(404,'not_found');
  const proof=await auth.verifyProof({proof:token,method:request.method,path:url.pathname,bodyBytes:bytes,challenge,publicJwk,expectedKid:kid,...(enrollment?{}:{epochId:prior.epoch.epochId})});
  if(!proof.ok)fail(proof.status??401,proof.code??'invalid_proof');
  const attested=(enrollment||create)?await attestation(request):null;
  const result=await store.transaction(state=>{
   // Recheck after asynchronous signature/token verification before consuming.
   const live=state.challenges[cid];if(!live||live.expiresAt<=now()||live.nonce!==challenge.nonce||live.ownerKey!==kid)fail(401,'expired_challenge');
   if(enrollment){
    if(state.retired)fail(409,'epoch_retired');
    if(state.epoch){if(state.epoch.ownerKey!==kid)fail(404,'not_found');delete state.challenges[cid];scheduling(state,config,now());return {status:200,body:enrollmentView(state.epoch)};}
    const epochId=ids('epoch'),analyticsUserId=ids('ga'),crashlyticsUserId=ids('crash');
    if(![epochId,analyticsUserId,crashlyticsUserId].every(identifier)||new Set([epochId,analyticsUserId,crashlyticsUserId]).size!==3)fail(503,'identity_generation_failed');
    state.epoch={epochId,ownerKey:kid,publicJwk,analyticsUserId,crashlyticsUserId,appId:attested.appId,issuedAt:iso(now()),policyVersion:config.policyVersion,retention:{receiptDays:config.retention.receiptDays,mappingDays:config.retention.mappingDays,retiredKeyPolicy:config.retention.retiredKeyPolicy},providerTargets:Object.fromEntries(NAMES.map(name=>[name,providerTarget(name,config)]))};delete state.challenges[cid];scheduling(state,config,now());return {status:201,body:enrollmentView(state.epoch)};
   }
   if(!state.epoch||state.epoch.ownerKey!==kid||state.epoch.epochId!==prior.epoch.epochId)fail(404,'not_found');
   if(create){
    if(state.receipt?.requestId===body.requestId&&state.receipt.fingerprint!==fingerprint(body))fail(409,'idempotency_conflict');
    if(body.epochId!==state.epoch.epochId)fail(404,'not_found');
    if(body.intent!=='delete_bound_diagnostics_and_stop'||body.policyVersion!==state.epoch.policyVersion||body.clientState.futureTelemetry!=='disabled_persisted')fail(400,'invalid_request');
    if(attested.appId!==state.epoch.appId)fail(403,'app_attestation_rejected');
    if(state.receipt){delete state.challenges[cid];scheduling(state,config,now());return {status:200,body:publicReceipt(state.receipt)};}
    if(!state.epoch.providerTargets||NAMES.some(name=>JSON.stringify(state.epoch.providerTargets[name])!==JSON.stringify(providerTarget(name,config))))fail(503,'provider_configuration_mismatch');
    if(state.retired)fail(409,'epoch_retired');
    const receipt={requestId:body.requestId,epochId:body.epochId,fingerprint:fingerprint(body),acceptedAt:iso(now()),clientState:body.clientState,retention:structuredClone(state.epoch.retention),providers:{}};
    for(const name of NAMES)receipt.providers[name]={state:'queued',attempt:0,nextAt:now(),targetId:state.epoch[name==='analytics'?'analyticsUserId':'crashlyticsUserId'],providerTarget:state.epoch.providerTargets[name]};
    state.receipt=receipt;state.retired=true;delete state.challenges[cid];scheduling(state,config,now());return {status:202,body:publicReceipt(receipt)};
   }
   if(!state.receipt||state.receipt.requestId!==match[1]||(settled(state.receipt)&&state.receipt.settledAt+state.receipt.retention.receiptDays*DAY<=now()))fail(404,'not_found');
   if(update)advanceClient(state.receipt,body.clientState);
   delete state.challenges[cid];scheduling(state,config,now());return {status:200,body:publicReceipt(state.receipt)};
  });return json(result.body,result.status);
 }catch(error){return errorResponse(error);}}
 function enrollmentView(epoch){return {schemaVersion:1,epochId:epoch.epochId,analyticsUserId:epoch.analyticsUserId,crashlyticsUserId:epoch.crashlyticsUserId,issuedAt:epoch.issuedAt,policyVersion:epoch.policyVersion,retention:structuredClone(epoch.retention)};}
 async function alarm(){
  if(!enabled)throw new Error('not_configured');
  const claims=await store.transaction(state=>{
   prune(state,config,now());const values=[];
   if(state.receipt)for(const name of NAMES){const job=state.receipt.providers[name];const due=providerReady(state.receipt,name)&&((['queued','retry_wait'].includes(job.state)&&job.nextAt<=now())||(job.state==='in_flight'&&job.leaseUntil<=now()));
    if(due&&JSON.stringify(job.providerTarget)!==JSON.stringify(providerTarget(name,config))){job.state='operator_action_required';job.errorCode='provider_configuration_mismatch';delete job.nextAt;delete job.lease;delete job.leaseUntil;continue;}
    if(due){job.state='in_flight';job.lease=++state.leaseSequence;job.leaseUntil=now()+config.jobs.leaseMs;job.attempt++;values.push({name,targetId:job.targetId,attempt:job.attempt,lease:job.lease});}}
   scheduling(state,config,now());return values;
  });
  await Promise.all(claims.map(async claim=>{
   let result;try{result=await providers[claim.name].submit({targetId:claim.targetId,attempt:claim.attempt});}catch{result={state:'retry_wait',completionEvidence:'none',errorCode:'adapter_unavailable',nextRetryAt:iso(now()+config.google.retryBaseMs)};}
   await store.transaction(state=>{const job=state.receipt?.providers[claim.name];if(!job||job.state!=='in_flight'||job.lease!==claim.lease)return;
    const safe=safeAdapter(claim.name,result,now(),config);for(const field of ['deletionRequestTime','targetCompleteTime','nextRetryAt','errorCode','nextAt'])delete job[field];Object.assign(job,safe);delete job.lease;delete job.leaseUntil;scheduling(state,config,now());});
  }));return {claimed:claims.length};
 }
 async function resumeAfterConfigurationFix(requestId,provider){
  // Internal maintenance operation only; the public gateway has no route here.
  // It resumes an existing failed job with its original target after review.
  if(!enabled)fail(503,'not_configured');
  if(!uuid(requestId)||!NAMES.includes(provider))fail(400,'invalid_request');
  return store.transaction(state=>{
   const record=state.receipt;if(!record||record.requestId!==requestId)fail(404,'not_found');
   const job=record.providers[provider];
   if(job.additionalSubmissionRequired)fail(409,'additional_review_required');
   if(job.state!=='operator_action_required')return {resumed:false};
   if(JSON.stringify(job.providerTarget)!==JSON.stringify(providerTarget(provider,config)))fail(503,'provider_configuration_mismatch');
   if(job.lastOperatorResumeAt!==undefined&&job.lastOperatorResumeAt+config.google.retryBaseMs>now())fail(429,'rate_limited');
   job.lastOperatorResumeAt=now();job.state='queued';job.nextAt=now();delete job.errorCode;
   scheduling(state,config,now());return {resumed:true};
  });
 }
 return {fetch,alarm,capabilities,resumeAfterConfigurationFix};
}
function advanceClient(receipt,next){
 const allowed={futureTelemetry:{restart_required:['disabled_persisted','sdk_unavailable'],sdk_unavailable:['disabled_persisted']},analyticsLocal:{pending:['failed','reset_requested','unavailable'],failed:['reset_requested','unavailable'],unavailable:['failed','reset_requested']},crashlyticsLocal:{pending:['failed','restart_required','delete_queued','no_unsent_reports_observed','unavailable'],failed:['restart_required','delete_queued','no_unsent_reports_observed','unavailable'],restart_required:['delete_queued','no_unsent_reports_observed','unavailable'],delete_queued:['no_unsent_reports_observed'],unavailable:['failed','restart_required','delete_queued','no_unsent_reports_observed']}};
 const before={...receipt.clientState};for(const key of Object.keys(states))if(allowed[key][before[key]]?.includes(next[key]))receipt.clientState[key]=next[key];
 for(const name of NAMES){
  const field=name==='analytics'?'analyticsLocal':'crashlyticsLocal';
  const changed=before[field]!==receipt.clientState[field]||before.futureTelemetry!==receipt.clientState.futureTelemetry;
  // A stronger observation after an already-ready local deletion does not
  // introduce a new target or new collection. Preserve the safety flag when
  // genuinely delayed stop/reset progress follows an already-started request.
  const readyBefore=providerReady({clientState:before},name),readyAfter=providerReady(receipt,name);
  if(changed&&(!readyBefore||!readyAfter)&&['in_flight','submitted'].includes(receipt.providers[name].state))receipt.providers[name].additionalSubmissionRequired=true;
 }
}
