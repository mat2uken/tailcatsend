import {readBody,json,ApiError,errorResponse} from './coordinator.mjs';
const bindingsReady=env=>typeof env.DIAGNOSTIC_EPOCHS?.idFromName==='function'&&typeof env.DIAGNOSTIC_EPOCHS?.get==='function'&&typeof env.PRIVACY_RATE_LIMIT?.limit==='function';
const disabled=()=>({schemaVersion:1,platforms:['android'],enrollmentEnabled:false,remoteDeletionEnabled:false,providers:{analytics:'not_configured',crashlytics:'permission_verification_required',mlkit:'unsupported'},legacyDeletion:'not_automated',remoteCompletionEvidence:'submission_only'});
export function createGateway({runtime}) { return {
 async fetch(request,env){
  try{
   const url=new URL(request.url);if(url.search)throw new ApiError(400,'invalid_request');
   let service;try{service=runtime(env);}catch{
    if(request.method==='GET'&&url.pathname==='/v1/capabilities')return json(disabled());throw new ApiError(503,'not_configured');
   }
   if(request.method==='GET'&&url.pathname==='/v1/capabilities'){
    if(!bindingsReady(env))return json(disabled());
    return json({...disabled(),enrollmentEnabled:true,remoteDeletionEnabled:true,providers:{analytics:'configured',crashlytics:'configured',mlkit:'unsupported'}});
   }
   if(!bindingsReady(env))throw new ApiError(503,'not_configured');
   const kid=request.headers.get('Ponlet-Privacy-Key');if(!/^[A-Za-z0-9_-]{43}$/.test(kid??''))throw new ApiError(401,'invalid_proof');
   const ip=request.headers.get('CF-Connecting-IP');if(!ip)throw new ApiError(503,'not_configured');
   // Cloudflare overrides CF-Connecting-IP at the public edge. Never log it.
   const rate=await env.PRIVACY_RATE_LIMIT.limit({key:ip});if(!rate?.success)throw new ApiError(429,'rate_limited');
   const bounded=await readBody(request.clone(),service.config.limits.maxBodyBytes,service.config.limits.bodyReadTimeoutMs);
   if(!['GET','POST'].includes(request.method)||!/^\/v1\/(challenges|enrollments|requests)(?:\/[0-9a-f-]{36}(?:\/client-state)?)?$/.test(url.pathname))throw new ApiError(404,'not_found');
   // New enrollment/creation cannot allocate unlimited un-attested key objects.
   let requiresAppCheck=request.method==='POST'&&['/v1/enrollments','/v1/requests'].includes(url.pathname);
   if(request.method==='POST'&&url.pathname==='/v1/challenges'){
    let input;try{input=JSON.parse(bounded.text);}catch{throw new ApiError(400,'invalid_request');}
    if(!input||!['GET','POST'].includes(input.method)||typeof input.path!=='string')throw new ApiError(400,'invalid_request');
    requiresAppCheck=input.method==='POST'&&['/v1/enrollments','/v1/requests'].includes(input.path);
   }
   if(requiresAppCheck){
    const check=await service.auth.verifyAppCheck(request.headers.get('X-Firebase-AppCheck'));if(!check.ok)throw new ApiError(403,'app_attestation_rejected');
   }
   const id=env.DIAGNOSTIC_EPOCHS.idFromName(kid);return env.DIAGNOSTIC_EPOCHS.get(id).fetch(request);
  }catch(error){return errorResponse(error);}
 },
}; }
