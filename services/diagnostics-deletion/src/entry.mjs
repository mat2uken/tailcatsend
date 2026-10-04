import {DurableObject} from 'cloudflare:workers';
import {readConfig} from './config.mjs';
import {createAuth} from './auth.mjs';
import {createGoogleProviders} from './providers.mjs';
import {createServiceAccountTokenProvider} from './oauth.mjs';
import {createDurableStore} from './storage.mjs';
import {createDeletionService,createRandomIds,ApiError,errorResponse} from './coordinator.mjs';
import {createGateway} from './gateway.mjs';
const runtimeCache = new WeakMap();
function runtime(env){
 const cached=runtimeCache.get(env);if(cached)return cached;
 const config=readConfig(env);
 const tokenProvider=createServiceAccountTokenProvider({email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,privateKeyPem:env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY});
 if(!config.enabled||config.googleAdapterMode!=='live'||!config.google.crashlyticsIamVerified||!tokenProvider.configured)throw new ApiError(503,'not_configured');
 const value={config,auth:createAuth({config}),providers:createGoogleProviders({config,tokenProvider})};
 runtimeCache.set(env,value);return value;
}
/** Gateway does bounded input/rate checks before allocating a Durable Object.
 * No credentials, tokens, diagnostic IDs, requests, or errors are logged. */
export default createGateway({runtime});
export class DiagnosticEpoch extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;}
 service(ownerKey){const components=runtime(this.env);return createDeletionService({...components,ownerKey,store:createDurableStore(this.ctx.storage),ids:createRandomIds()});}
 async fetch(request){try{return await this.service(request.headers.get('Ponlet-Privacy-Key')).fetch(request);}catch(error){return errorResponse(error);}}
 // Callable only through an authorized Durable Object namespace binding.
 // No HTTP route, browser credential, or app command exposes this maintenance action.
 async resumeAfterConfigurationFix(requestId,provider){
  const state=await createDurableStore(this.ctx.storage).read();
  if(!state.epoch?.ownerKey)throw new Error('not_found');
  return this.service(state.epoch.ownerKey).resumeAfterConfigurationFix(requestId,provider);
 }
 async alarm(){
  // Fetch persisted ownerKey rather than any alarm/input header.
  const store=createDurableStore(this.ctx.storage),state=await store.read();
  const ownerKey=state.epoch?.ownerKey??Object.values(state.challenges)[0]?.ownerKey;
  if(!ownerKey)return;
  try { await this.service(ownerKey).alarm(); }
  catch(error) {
   if(error?.code!=='not_configured')throw error;
   // Keep an already accepted request scheduled while credentials/configuration
   // are being repaired. Use the previously explicit operational retry interval.
   if(!Number.isSafeInteger(state.recoveryDelayMs)||state.recoveryDelayMs<1||state.recoveryDelayMs>86400000)throw error;
   await store.transaction(current=>{
    const timestamp=Date.now();
    for(const [key,challenge] of Object.entries(current.challenges))if(challenge.expiresAt<=timestamp)delete current.challenges[key];
    const retentionPending=current.mappingPurgeAt!==null&&current.mappingPurgeAt!==undefined;
    current.alarmAt=current.receipt||retentionPending ? timestamp+state.recoveryDelayMs :
      Object.values(current.challenges).reduce((next,c)=>Math.min(next,c.expiresAt),Infinity);
    if(current.alarmAt===Infinity)current.alarmAt=null;
   });
  }
 }
}
