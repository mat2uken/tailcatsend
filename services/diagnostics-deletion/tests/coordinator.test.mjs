import test from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readConfig} from '../src/config.mjs';import {createDurableStore} from '../src/storage.mjs';import {createDeletionService} from '../src/coordinator.mjs';import {sqliteStorage} from './fixtures/storage.mjs';import {FIXTURE_ENV,FIXTURE_NOW} from './fixtures/config.mjs';
const signing=JSON.parse(await readFile(new URL('./fixtures/auth-signatures.json',import.meta.url),'utf8'));
const RID='11111111-1111-4111-8111-111111111111',RID2='33333333-3333-4333-8333-333333333333';
const b64=s=>Buffer.from(s).toString('base64url');
const stable=(label,n)=>label+'_'+String(n).padStart(43,'0');
const local={futureTelemetry:'disabled_persisted',analyticsLocal:'reset_requested',crashlyticsLocal:'delete_queued'};
async function harness(options={}){
 let time=FIXTURE_NOW,sequence=0,lastSigned=null;const config=readConfig({...FIXTURE_ENV,MAX_CHALLENGES:'100',MAX_CHALLENGES_PER_WINDOW:'100',...options.env});
 const storage=options.storage??sqliteStorage(),store=createDurableStore(storage),proofs=new Map(),calls={analytics:[],crashlytics:[]};
 const auth={async verifyAppCheck(token){return token==='fixture-appcheck'?{ok:true,appId:config.appCheck.appIds[0]}:{ok:false,status:403,code:'app_attestation_rejected'};},async verifyProof(input){const expected=proofs.get(input.proof);return expected&&expected.method===input.method&&expected.path===input.path&&expected.body===new TextDecoder().decode(input.bodyBytes)&&expected.cid===input.challenge.challengeId?{ok:true}:{ok:false,status:401,code:'invalid_proof'};}};
 const providers={};for(const name of ['analytics','crashlytics'])providers[name]={async submit(input){calls[name].push(input);return options.results?.[name]??{state:'submitted',completionEvidence:'submission_only',[name==='analytics'?'deletionRequestTime':'targetCompleteTime']:'2026-10-04T00:01:00Z'};}};
 let service=createDeletionService({config,store,auth,providers,now:()=>time,ownerKey:signing.kid,ids:(label)=>stable(label,++sequence)});
 async function bare(method,path,body,headers={}){const response=await service.fetch(new Request(config.audience+path,{method,headers:{'Content-Type':'application/json','Ponlet-Privacy-Key':signing.kid,'X-Firebase-AppCheck':'fixture-appcheck',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}));return {status:response.status,body:await response.json(),headers:response.headers};}
 async function signed(method,path,body,mutations={}){
  const enrollment=path==='/v1/enrollments';const issued=await bare('POST','/v1/challenges',{schemaVersion:1,kid:signing.kid,method,path,...(enrollment?{publicJwk:signing.publicJwk}:{})});assert.equal(issued.status,201);
  const cid=issued.body.challengeId,proof='e30.'+b64(JSON.stringify({challengeId:cid}))+'.AA';
  proofs.set(proof,{method,path,body:body===undefined?'':JSON.stringify(body),cid});
  lastSigned={method:mutations.method??method,path:mutations.path??path,body:mutations.body??body,headers:{'Ponlet-Privacy-Proof':proof,...mutations.headers}};
  return bare(lastSigned.method,lastSigned.path,lastSigned.body,lastSigned.headers);
 }
 async function enroll(){return signed('POST','/v1/enrollments',{schemaVersion:1,enrollmentRequestId:'22222222-2222-4222-8222-222222222222',platform:'android',publicJwk:signing.publicJwk});}
 async function create(extra={}){const state=await store.read();return signed('POST','/v1/requests',{schemaVersion:1,requestId:RID,epochId:state.epoch.epochId,intent:'delete_bound_diagnostics_and_stop',policyVersion:config.policyVersion,clientState:local,...extra});}
 return {config,storage,store,get service(){return service;},providers,calls,bare,signed,enroll,create,reconfigure(env){service=createDeletionService({config:readConfig({...FIXTURE_ENV,MAX_CHALLENGES:'100',MAX_CHALLENGES_PER_WINDOW:'100',...env}),store,auth,providers,now:()=>time,ownerKey:signing.kid,ids:(label)=>stable(label,++sequence)});},get lastSigned(){return lastSigned;},advance(ms){time+=ms;},now:()=>time};
}

test('missing SQLite storage is rejected rather than falling back to memory',()=>{assert.throws(()=>createDurableStore({}),/sqlite_storage_required/);});
test('disabled feature and unverified IAM never issue IDs or accept changes',async()=>{
 for(const env of [{DELETION_ENABLED:'false'},{GOOGLE_ADAPTER_MODE:'fixture'},{CRASHLYTICS_MINIMAL_IAM_VERIFIED:'false'}]){const h=await harness({env});const r=await h.bare('GET','/v1/capabilities');assert.equal(r.body.remoteDeletionEnabled,false);assert.equal((await h.bare('POST','/v1/challenges',{})).status,503);assert.equal((await h.store.read()).epoch,null);h.storage.close();}
});
test('enrollment binds independent server-issued IDs and repeated enrollment returns same epoch',async()=>{
 const h=await harness();const first=await h.enroll(),again=await h.enroll();assert.equal(first.status,201);assert.equal(again.status,200);assert.deepEqual(again.body,first.body);assert.notEqual(first.body.analyticsUserId,first.body.crashlyticsUserId);assert.equal((await h.store.read()).epoch.publicJwk.kty,'EC');h.storage.close();
});
test('new enrollment cannot introduce a client Google ID or private JWK component',async()=>{
 const h=await harness();const r=await h.signed('POST','/v1/enrollments',{schemaVersion:1,enrollmentRequestId:RID,platform:'android',publicJwk:signing.publicJwk,userId:'foreign'});assert.equal(r.status,400);const c=await h.bare('POST','/v1/challenges',{schemaVersion:1,kid:signing.kid,method:'POST',path:'/v1/enrollments',publicJwk:{...signing.publicJwk,d:'forbidden'}});assert.equal(c.status,400);h.storage.close();
});
test('202 atomically persists receipt, retired epoch, consumed nonce and earliest alarm',async()=>{
 const h=await harness();await h.enroll();const result=await h.create();assert.equal(result.status,202);assert.equal(result.body.state,'accepted');const s=await h.store.read();assert.equal(s.retired,true);assert.equal(s.receipt.providers.analytics.targetId,s.epoch.analyticsUserId);assert.equal(h.storage.alarmAt(),h.now());assert.equal(Object.keys(s.challenges).length,0);assert.ok(!JSON.stringify(result.body).includes(s.epoch.analyticsUserId));h.storage.close();
});
test('challenge alarm save failure rolls challenge issuance back',async()=>{
 const h=await harness();await h.enroll();const body={schemaVersion:1,requestId:RID,epochId:(await h.store.read()).epoch.epochId,intent:'delete_bound_diagnostics_and_stop',policyVersion:h.config.policyVersion,clientState:local};
 const challenge=await h.bare('POST','/v1/challenges',{schemaVersion:1,kid:signing.kid,method:'POST',path:'/v1/requests'});const before=await h.store.read();h.storage.failNext('alarm');
 // Fail during a new challenge first: rollback preserves already issued challenge.
 const failed=await h.bare('POST','/v1/challenges',{schemaVersion:1,kid:signing.kid,method:'POST',path:'/v1/requests'});assert.equal(failed.status,503);assert.deepEqual(await h.store.read(),before);
 assert.equal((await h.create()).status,202);h.storage.close();
});
test('receipt transaction itself fails closed when persistence cannot commit',async()=>{
 const h=await harness();await h.enroll();const original=h.store.transaction;let count=0;h.store.transaction=async cb=>{if(++count===2)h.storage.failNext('alarm');return original(cb);};
 const failed=await h.create();assert.equal(failed.status,503);assert.equal((await h.store.read()).receipt,null);assert.equal((await h.store.read()).retired,false);const retry=h.lastSigned;assert.equal((await h.bare(retry.method,retry.path,retry.body,retry.headers)).status,202);h.storage.close();
});
test('twenty concurrent signed creations produce one canonical receipt and one job per provider',async()=>{
 const h=await harness();await h.enroll();const results=await Promise.all(Array.from({length:20},()=>h.create()));assert.equal(results.filter(r=>r.status===202).length,1);assert.equal(results.filter(r=>r.status===200).length,19);await Promise.all(Array.from({length:10},()=>h.service.alarm()));assert.equal(h.calls.analytics.length,1);assert.equal(h.calls.crashlytics.length,1);h.storage.close();
});
test('idempotency conflict and alternate request IDs never enlarge the deletion jobs',async()=>{
 const h=await harness();await h.enroll();await h.create();const conflicting=await h.create({intent:'different'});assert.equal(conflicting.status,409);const duplicate=await h.create({requestId:RID2});assert.equal(duplicate.status,200);assert.equal(duplicate.body.requestId,RID);assert.equal((await h.enroll()).status,409);h.storage.close();
});
test('unsupported schema, foreign IDs, oversized and invalid bodies never create jobs',async()=>{
 const h=await harness();await h.enroll();for(const field of ['appInstanceId','userId','project','property'])assert.equal((await h.create({[field]:'foreign'})).status,400);assert.equal((await h.bare('POST','/v1/requests','x'.repeat(8193))).status,413);assert.equal((await h.bare('POST','/v1/requests','{')).status,400);assert.equal((await h.store.read()).receipt,null);h.storage.close();
});
test('App Check rejection does not consume a valid nonce or persist deletion',async()=>{
 const h=await harness();await h.enroll();const s=await h.store.read();const body={schemaVersion:1,requestId:RID,epochId:s.epoch.epochId,intent:'delete_bound_diagnostics_and_stop',policyVersion:h.config.policyVersion,clientState:local};const result=await h.signed('POST','/v1/requests',body,{headers:{'X-Firebase-AppCheck':'rejected'}});assert.equal(result.status,403);assert.equal((await h.store.read()).receipt,null);assert.equal(Object.keys((await h.store.read()).challenges).length,1);h.storage.close();
});
test('bad proof does not consume nonce and routing-key mismatch is closed',async()=>{
 const h=await harness();await h.enroll();const result=await h.signed('GET','/v1/requests/'+RID,undefined,{headers:{'Ponlet-Privacy-Proof':'invalid'}});assert.equal(result.status,401);assert.equal(Object.keys((await h.store.read()).challenges).length,1);assert.equal((await h.bare('GET','/v1/requests/'+RID,undefined,{'Ponlet-Privacy-Key':'A'.repeat(43)})).status,401);h.storage.close();
});
test('challenge count and expiry impose bounded storage, including unknown-key status challenges',async()=>{
 const h=await harness({env:{MAX_CHALLENGES:'2',MAX_CHALLENGES_PER_WINDOW:'2'}});const b={schemaVersion:1,kid:signing.kid,method:'GET',path:'/v1/requests/'+RID};assert.equal((await h.bare('POST','/v1/challenges',b,{'X-Firebase-AppCheck':''})).status,201);assert.equal((await h.bare('POST','/v1/challenges',b)).status,201);assert.equal((await h.bare('POST','/v1/challenges',b)).status,429);h.advance(300000);assert.equal((await h.bare('POST','/v1/challenges',b)).status,201);assert.equal(Object.keys((await h.store.read()).challenges).length,1);h.storage.close();
});
test('registered status/client-state work without an App Check refresh',async()=>{
 const h=await harness();await h.enroll();await h.create({clientState:{...local,crashlyticsLocal:'restart_required'}});const read=await h.signed('GET','/v1/requests/'+RID,undefined,{headers:{'X-Firebase-AppCheck':''}});assert.equal(read.status,200);const update=await h.signed('POST','/v1/requests/'+RID+'/client-state',{schemaVersion:1,clientState:local},{headers:{'X-Firebase-AppCheck':''}});assert.equal(update.status,200);assert.equal(update.body.clientContinuation,'none');h.storage.close();
});
test('provider acceptance is never completion and partial permission failure preserves accepted receipt',async()=>{
 const h=await harness({results:{crashlytics:{state:'operator_action_required',completionEvidence:'none',errorCode:'provider_permission_denied'}}});await h.enroll();await h.create();await h.service.alarm();h.advance(86400000);const r=await h.signed('GET','/v1/requests/'+RID);assert.equal(r.body.providers.analytics.state,'submitted');assert.equal(r.body.state,'operator_action_required');assert.ok(r.body.acceptedAt);assert.equal(r.body.completionEvidence,'submission_only');h.storage.close();
});
test('Retry-After and receipt survive actual local SQLite close/reopen',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ponlet-sqlite-'));const path=join(directory,'fixture.sqlite');const h=await harness({storage:sqliteStorage(path),results:{crashlytics:{state:'retry_wait',completionEvidence:'none',errorCode:'rate_limited',nextRetryAt:'2026-10-04T00:02:00Z'}}});
 try{await h.enroll();await h.create();await h.service.alarm();assert.equal(h.storage.alarmAt(),FIXTURE_NOW+120000);h.storage.close();const reopened=sqliteStorage(path);const store=createDurableStore(reopened);const state=await store.read();assert.equal(state.receipt.providers.analytics.state,'submitted');assert.equal(state.receipt.providers.crashlytics.state,'retry_wait');assert.equal(reopened.alarmAt(),FIXTURE_NOW+120000);reopened.close();}finally{await rm(directory,{recursive:true,force:true});}
});
test('stronger observation after ready local deletion does not force additional submission',async()=>{
 const h=await harness();await h.enroll();await h.create();let release;h.providers.crashlytics.submit=()=>new Promise(r=>{release=r;});const alarm=h.service.alarm();await new Promise(r=>setImmediate(r));await h.signed('POST','/v1/requests/'+RID+'/client-state',{schemaVersion:1,clientState:{...local,crashlyticsLocal:'no_unsent_reports_observed'}});release({state:'submitted',completionEvidence:'submission_only',targetCompleteTime:'2026-10-04T00:01:00Z'});await alarm;const r=await h.signed('GET','/v1/requests/'+RID);assert.equal(r.body.providers.crashlytics.additionalSubmissionRequired,undefined);assert.equal(r.body.providers.analytics.additionalSubmissionRequired,undefined);h.storage.close();
});
test('unresolved requests are never purged just because retention time elapsed',async()=>{
 const h=await harness({results:{crashlytics:{state:'operator_action_required',completionEvidence:'none',errorCode:'provider_permission_denied'}}});await h.enroll();await h.create();await h.service.alarm();h.advance(100*86400000);await h.service.alarm();assert.ok((await h.store.read()).receipt);assert.ok((await h.store.read()).epoch);h.storage.close();
});
test('separate receipt/mapping retention removes data only after settled state and retains retired-key tombstone',async()=>{
 const h=await harness({env:{RECEIPT_RETENTION_DAYS:'1',MAPPING_RETENTION_DAYS:'2'}});await h.enroll();await h.create();await h.service.alarm();h.advance(86400000);await h.service.alarm();let s=await h.store.read();assert.equal(s.receipt,null);assert.ok(s.epoch.analyticsUserId);assert.equal(h.storage.alarmAt(),FIXTURE_NOW+2*86400000);h.advance(86400000);await h.service.alarm();s=await h.store.read();assert.equal(s.epoch,null);assert.equal(s.retired,true);assert.equal(s.alarmAt,null);assert.equal((await h.enroll()).status,409);h.storage.close();
});
test('malicious adapter properties are never sent to the client',async()=>{
 const h=await harness({results:{analytics:{state:'submitted',completionEvidence:'submission_only',deletionRequestTime:'2026-02-30T00:00:00Z',raw:'private_error'}}});await h.enroll();await h.create();await h.service.alarm();const r=await h.signed('GET','/v1/requests/'+RID);assert.equal(r.body.providers.analytics.errorCode,'adapter_invalid_result');assert.ok(!JSON.stringify(r.body).includes('private_error'));h.storage.close();
});
test('result-save failure leaves an in-flight lease and recovers with possible provider re-submission',async()=>{
 const h=await harness();await h.enroll();await h.create();const original=h.providers.analytics.submit;let injected=false;
 h.providers.analytics.submit=async input=>{const value=await original(input);if(!injected){injected=true;h.storage.failNext('put');}return value;};
 await assert.rejects(()=>h.service.alarm());await new Promise(r=>setImmediate(r));const state=await h.store.read();assert.ok(Object.values(state.receipt.providers).some(j=>j.state==='in_flight'));assert.equal(h.storage.alarmAt(),h.now()+h.config.jobs.leaseMs);
 h.advance(h.config.jobs.leaseMs);await h.service.alarm();assert.equal((await h.signed('GET','/v1/requests/'+RID)).body.state,'provider_submitted');assert.equal(h.calls.analytics.length+h.calls.crashlytics.length,3);h.storage.close();
});
test('bad timestamp without extra adapter fields cannot claim provider acceptance',async()=>{
 const h=await harness({results:{analytics:{state:'submitted',completionEvidence:'submission_only',deletionRequestTime:'2026-02-30T00:00:00Z'}}});await h.enroll();await h.create();await h.service.alarm();const r=await h.signed('GET','/v1/requests/'+RID);assert.equal(r.body.providers.analytics.errorCode,'adapter_invalid_result');h.storage.close();
});
test('policy-version update still accepts the version bound to an already enrolled epoch',async()=>{
 const h=await harness();await h.enroll();h.reconfigure({DELETION_POLICY_VERSION:'future_policy_v2'});const result=await h.create();assert.equal(result.status,202);assert.equal((await h.store.read()).epoch.policyVersion,'fixture_v1');h.storage.close();
});
test('provider destination changes cannot redirect enrolled IDs to a different property',async()=>{
 const h=await harness();await h.enroll();h.reconfigure({ANALYTICS_PROPERTY_ID:'987654321'});const result=await h.create();assert.equal(result.status,503);assert.equal(result.body.error.code,'provider_configuration_mismatch');assert.equal((await h.store.read()).receipt,null);assert.equal(h.calls.analytics.length,0);h.storage.close();
});
test('queued provider targets stay pinned across environment changes, retaining unaffected progress',async()=>{
 const h=await harness();await h.enroll();await h.create();h.reconfigure({ANALYTICS_PROPERTY_ID:'987654321'});await h.service.alarm();const r=await h.signed('GET','/v1/requests/'+RID);assert.equal(r.body.providers.analytics.errorCode,'provider_configuration_mismatch');assert.equal(r.body.providers.crashlytics.state,'submitted');assert.equal(h.calls.analytics.length,0);assert.equal(h.calls.crashlytics.length,1);h.storage.close();
});
test('lost receipt response is recoverable even after provider destination changes',async()=>{
 const h=await harness();await h.enroll();const first=await h.create();h.reconfigure({ANALYTICS_PROPERTY_ID:'987654321'});const replay=await h.create();assert.equal(replay.status,200);assert.deepEqual(replay.body,first.body);assert.equal(h.calls.analytics.length,0);assert.equal((await h.store.read()).receipt.requestId,RID);h.storage.close();
});
test('internal reviewed resume retries only a failed provider and preserves successful evidence',async()=>{
 const h=await harness({results:{crashlytics:{state:'operator_action_required',completionEvidence:'none',errorCode:'provider_permission_denied'}}});await h.enroll();await h.create();await h.service.alarm();
 h.providers.crashlytics.submit=async input=>{h.calls.crashlytics.push(input);return {state:'submitted',completionEvidence:'submission_only',targetCompleteTime:'2026-10-04T00:01:00Z'};};
 assert.deepEqual(await h.service.resumeAfterConfigurationFix(RID,'crashlytics'),{resumed:true});assert.deepEqual(await h.service.resumeAfterConfigurationFix(RID,'crashlytics'),{resumed:false});await h.service.alarm();const r=await h.signed('GET','/v1/requests/'+RID);assert.equal(r.body.state,'provider_submitted');assert.equal(h.calls.analytics.length,1);assert.equal(h.calls.crashlytics.length,2);h.storage.close();
});
test('internal resume cannot change target or bypass unresolved late-arrival review',async()=>{
 const h=await harness({results:{analytics:{state:'operator_action_required',completionEvidence:'none',errorCode:'provider_permission_denied'}}});await h.enroll();await h.create();await h.service.alarm();h.reconfigure({ANALYTICS_PROPERTY_ID:'987654321'});await assert.rejects(()=>h.service.resumeAfterConfigurationFix(RID,'analytics'),/provider_configuration_mismatch/);
 await h.store.transaction(s=>{s.receipt.providers.crashlytics.additionalSubmissionRequired=true;});await assert.rejects(()=>h.service.resumeAfterConfigurationFix(RID,'crashlytics'),/additional_review_required/);h.storage.close();
});
test('retention remains bound to the enrolled policy after deployment settings change',async()=>{
 const h=await harness();await h.enroll();await h.create();await h.service.alarm();h.reconfigure({DELETION_POLICY_VERSION:'future_policy_v2',RECEIPT_RETENTION_DAYS:'1',MAPPING_RETENTION_DAYS:'1'});h.advance(2*86400000);await h.service.alarm();assert.ok((await h.store.read()).receipt);assert.equal((await h.store.read()).receipt.retention.receiptDays,30);h.advance(28*86400000);await h.service.alarm();assert.equal((await h.store.read()).receipt,null);assert.equal((await h.store.read()).epoch,null);h.storage.close();
});
test('unavailable SDK result is not settlement evidence and cannot trigger retention purge',async()=>{
 const h=await harness({env:{RECEIPT_RETENTION_DAYS:'1',MAPPING_RETENTION_DAYS:'1'}});await h.enroll();await h.create({clientState:{...local,analyticsLocal:'unavailable',crashlyticsLocal:'unavailable'}});await h.service.alarm();h.advance(3*86400000);await h.service.alarm();assert.ok((await h.store.read()).receipt);assert.ok((await h.store.read()).epoch);
 const progress=await h.signed('POST','/v1/requests/'+RID+'/client-state',{schemaVersion:1,clientState:local});assert.equal(progress.status,200);assert.equal(progress.body.clientState.analyticsLocal,'reset_requested');assert.equal(progress.body.providers.analytics.additionalSubmissionRequired,undefined);assert.equal(h.calls.analytics.length,0);assert.equal(h.calls.crashlytics.length,0);await h.service.alarm();assert.equal(h.calls.analytics.length,1);assert.equal(h.calls.crashlytics.length,1);h.storage.close();
});

test('normal restart waits for local acknowledgment before first Crashlytics submission without alarm loop',async()=>{
 const h=await harness();await h.enroll();await h.create({clientState:{...local,crashlyticsLocal:'restart_required'}});await h.service.alarm();
 assert.equal(h.calls.analytics.length,1);assert.equal(h.calls.crashlytics.length,0);assert.equal(h.storage.alarmAt(),null);
 const pending=await h.signed('GET','/v1/requests/'+RID);assert.equal(pending.body.clientContinuation,'restart_required');assert.equal(pending.body.providers.crashlytics.state,'queued');assert.equal(h.storage.alarmAt(),null);
 const ack=await h.signed('POST','/v1/requests/'+RID+'/client-state',{schemaVersion:1,clientState:local});assert.equal(ack.body.clientContinuation,'none');assert.equal(h.storage.alarmAt(),h.now());await h.service.alarm();
 const done=await h.signed('GET','/v1/requests/'+RID);assert.equal(done.body.state,'provider_submitted');assert.equal(done.body.providers.crashlytics.additionalSubmissionRequired,undefined);assert.equal(h.calls.analytics.length,1);assert.equal(h.calls.crashlytics.length,1);assert.ok((await h.store.read()).receipt.settledAt);h.storage.close();
});
test('failed Analytics reset does not block independent Crashlytics submission or spin alarms',async()=>{
 const h=await harness();await h.enroll();await h.create({clientState:{...local,analyticsLocal:'failed'}});await h.service.alarm();assert.equal(h.calls.analytics.length,0);assert.equal(h.calls.crashlytics.length,1);assert.equal(h.storage.alarmAt(),null);
 await h.signed('POST','/v1/requests/'+RID+'/client-state',{schemaVersion:1,clientState:local});await h.service.alarm();assert.equal(h.calls.analytics.length,1);assert.equal(h.calls.crashlytics.length,1);assert.equal((await h.store.read()).receipt.providers.crashlytics.additionalSubmissionRequired,undefined);h.storage.close();
});

test('genuinely delayed local stop progress in a previously submitted record retains additional review',async()=>{
 const h=await harness();await h.enroll();await h.create();await h.service.alarm();
 // Recover an older persisted record that submitted before local readiness.
 await h.store.transaction(s=>{s.receipt.clientState.crashlyticsLocal='restart_required';delete s.receipt.settledAt;});
 const ack=await h.signed('POST','/v1/requests/'+RID+'/client-state',{schemaVersion:1,clientState:local});assert.equal(ack.body.providers.crashlytics.additionalSubmissionRequired,true);assert.equal(ack.body.state,'operator_action_required');assert.equal(ack.body.providers.analytics.additionalSubmissionRequired,undefined);h.storage.close();
});
test('enrollment returns the immutable retention policy so native can reject mismatched deployment settings',async()=>{
 const h=await harness();const first=await h.enroll();assert.deepEqual(first.body.retention,{receiptDays:30,mappingDays:30,retiredKeyPolicy:'retain_tombstone'});
 h.reconfigure({RECEIPT_RETENTION_DAYS:'1',MAPPING_RETENTION_DAYS:'2'});const repeated=await h.enroll();assert.equal(repeated.status,200);assert.deepEqual(repeated.body.retention,first.body.retention);
 first.body.retention.receiptDays=999;assert.equal((await h.store.read()).epoch.retention.receiptDays,30);h.storage.close();
});
