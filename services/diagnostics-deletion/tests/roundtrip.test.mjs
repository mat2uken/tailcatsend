import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {createAuth} from '../src/auth.mjs';import {readConfig} from '../src/config.mjs';import {createDeletionService} from '../src/coordinator.mjs';import {createDurableStore} from '../src/storage.mjs';import {sqliteStorage} from './fixtures/storage.mjs';import {FIXTURE_ENV} from './fixtures/config.mjs';
const signed=JSON.parse(await readFile(new URL('./fixtures/coordinator-signatures.json',import.meta.url),'utf8'));
const authFixture=JSON.parse(await readFile(new URL('./fixtures/auth-signatures.json',import.meta.url),'utf8'));
test('real ES256 and App Check RS256 enrollment→deletion→status use one SQLite-backed coordinator',async()=>{
 const config=readConfig(FIXTURE_ENV);let jwksCalls=0,sequence=0;
 const auth=createAuth({config,now:()=>signed.now,fetcher:async(url)=>{jwksCalls++;assert.equal(url,'https://firebaseappcheck.googleapis.com/v1/jwks');return new Response(JSON.stringify({keys:[authFixture.rsaJwk]}),{headers:{'Content-Type':'application/json'}});}});
 const storage=sqliteStorage(),store=createDurableStore(storage),calls=[];
 const providers=Object.fromEntries(['analytics','crashlytics'].map(name=>[name,{submit:async(input)=>{calls.push({name,...input});return {state:'submitted',completionEvidence:'submission_only',[name==='analytics'?'deletionRequestTime':'targetCompleteTime']:'2026-10-04T00:01:00Z'};}}]));
 const service=createDeletionService({config,auth,store,providers,now:()=>signed.now,ownerKey:signed.kid,ids:(label)=>label+'_'+String(++sequence).padStart(43,'0')});
 async function call(method,path,body,proof){const r=await service.fetch(new Request(config.audience+path,{method,headers:{'Content-Type':'application/json','Ponlet-Privacy-Key':signed.kid,'Ponlet-Privacy-Proof':proof??'','X-Firebase-AppCheck':signed.appCheckToken},body:body||undefined}));return {status:r.status,body:await r.json()};}
 try{for(const name of ['enroll','create','status']){
  const step=signed[name];const challenge=await call('POST','/v1/challenges',JSON.stringify({schemaVersion:1,kid:signed.kid,method:step.method,path:step.path,...(name==='enroll'?{publicJwk:signed.publicJwk}:{})}));assert.equal(challenge.status,201);assert.deepEqual(challenge.body,step.challenge);
  const result=await call(step.method,step.path,step.body,step.proof);assert.equal(result.status,{enroll:201,create:202,status:200}[name]);
  if(name==='enroll'){assert.equal(result.body.epochId,signed.epochId);assert.equal(result.body.analyticsUserId,signed.analyticsUserId);assert.equal(result.body.crashlyticsUserId,signed.crashlyticsUserId);assert.deepEqual(result.body.retention,{receiptDays:30,mappingDays:30,retiredKeyPolicy:'retain_tombstone'});}
  if(name==='create')await service.alarm();
  if(name==='status'){assert.equal(result.body.state,'provider_submitted');assert.equal(result.body.completionEvidence,'submission_only');assert.ok(!JSON.stringify(result.body).includes(signed.analyticsUserId));}
 }
 assert.equal(jwksCalls,1);assert.equal(calls.length,2);assert.equal(calls[0].targetId,signed.analyticsUserId);assert.equal(calls[1].targetId,signed.crashlyticsUserId);
 const replay=await call(signed.status.method,signed.status.path,signed.status.body,signed.status.proof);assert.equal(replay.status,401);
 }finally{storage.close();}
});
