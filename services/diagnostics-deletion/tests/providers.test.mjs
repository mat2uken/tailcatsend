import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleProviders, normalizeProviderResponse, isStrictTimestamp, GOOGLE_SCOPES} from '../src/providers.mjs';
import {readConfig} from '../src/config.mjs';
import {FIXTURE_ENV, FIXTURE_NOW} from './fixtures/config.mjs';
const config=readConfig(FIXTURE_ENV);
const targetId='ga_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const crashId='crash_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const token={accessToken:'fixture_access_token',expiresAt:FIXTURE_NOW+3600000};
const success={analytics:{deletionRequestTime:'2026-10-04T00:00:01.123456789Z'},crashlytics:{targetCompleteTime:'2026-10-05T00:00:00Z'}};
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
function setup({response=json(success.analytics),...extra}={}) {
  const calls=[]; const tokenCalls=[];
  const providers=createGoogleProviders({config,now:()=>FIXTURE_NOW,jitter:()=>1,
    tokenProvider:{async getToken(...args){tokenCalls.push(args);return token;}},
    fetcher:async(...args)=>{calls.push(args);return response;},...extra});
  return {providers,calls,tokenCalls};
}
test('Analytics fixed-host POST uses only stored target in userId union',async()=>{
  const {providers,calls,tokenCalls}=setup();
  assert.equal(providers.mode,'live'); assert.equal(providers.analytics.enabled,true);
  assert.deepEqual(await providers.analytics.submit({targetId,attempt:1}),{state:'submitted',...success.analytics,completionEvidence:'submission_only'});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'https://analyticsadmin.googleapis.com/v1alpha/properties/123456789:submitUserDeletion');
  assert.equal(calls[0][1].method,'POST');assert.equal(calls[0][1].redirect,'error');
  assert.deepEqual(JSON.parse(calls[0][1].body),{userId:targetId});
  assert.equal(calls[0][1].headers.Authorization,'Bearer fixture_access_token');
  assert.equal(tokenCalls[0][0],'analytics');assert.deepEqual(tokenCalls[0][1].scopes,GOOGLE_SCOPES.analytics);
  assert.equal(tokenCalls[0][1].signal,calls[0][1].signal);
});
test('Crashlytics fixed-host DELETE has truly empty body and an encoded app segment',async()=>{
  const {providers,calls,tokenCalls}=setup({response:json(success.crashlytics)});
  const result=await providers.crashlytics.submit({targetId:crashId,attempt:1});
  assert.deepEqual(result,{state:'submitted',...success.crashlytics,completionEvidence:'submission_only'});
  assert.equal(calls[0][0],`https://firebasecrashlytics.googleapis.com/v1alpha/projects/1234567890/apps/1%3A1234567890%3Aandroid%3A0123456789abcdef/users/${crashId}/crashReports`);
  assert.equal(calls[0][1].method,'DELETE');assert.equal(Object.hasOwn(calls[0][1],'body'),false);
  assert.equal(tokenCalls[0][0],'crashlytics');assert.deepEqual(tokenCalls[0][1].scopes,GOOGLE_SCOPES.crashlytics);
});
test('live success is unavailable when feature, adapter, target config, token provider or IAM are missing',async()=>{
  for(const altered of [undefined,{...config,enabled:false},{...config,googleAdapterMode:'fixture'},{...config,googleAdapterMode:undefined},
    {...config,google:{...config.google,analyticsPropertyId:'../../other'}},{...config,google:{...config.google,crashlyticsAppId:'1:999:android:0123456789abcdef'}}]) {
    const {providers,calls,tokenCalls}=setup({config:altered});
    assert.equal(providers.analytics.enabled,false);assert.equal((await providers.analytics.submit({targetId,attempt:1})).errorCode,'not_configured');
    assert.equal(calls.length,0);assert.equal(tokenCalls.length,0);
  }
  const {providers,calls,tokenCalls}=setup({config:{...config,google:{...config.google,crashlyticsIamVerified:false}}});
  assert.equal(providers.crashlytics.enabled,false);
  assert.deepEqual(await providers.crashlytics.submit({targetId:crashId,attempt:1}),{state:'unsupported',errorCode:'permission_verification_required',completionEvidence:'none'});
  assert.equal(calls.length,0);assert.equal(tokenCalls.length,0);
  const missing=setup({tokenProvider:undefined});assert.equal(missing.providers.analytics.enabled,false);
});
test('rejects path/query injection, arbitrary short IDs and invalid attempts before acquiring tokens',async()=>{
  const {providers,calls,tokenCalls}=setup();
  for(const id of ['..','../../other','id?secret=x','a'.repeat(65),'%2F'+targetId,'a b',null,'',targetId+'\n'])
    assert.equal((await providers.analytics.submit({targetId:id,attempt:1})).errorCode,'invalid_target');
  for(const attempt of [undefined,0,-1,1.5,Infinity,'1'])
    assert.equal((await providers.analytics.submit({targetId,attempt})).errorCode,'invalid_attempt');
  assert.equal(calls.length,0);assert.equal(tokenCalls.length,0);
});
test('bad or expired tokens and token provider exceptions are sanitized and never fetched',async()=>{
  for(const result of [null,{}, {...token,accessToken:'secret\r\nInjected:yes'},{...token,accessToken:''},
    {...token,accessToken:'a'.repeat(8193)},{...token,expiresAt:FIXTURE_NOW}, {...token,expiresAt:FIXTURE_NOW+500}]) {
    const {providers,calls}=setup({tokenProvider:{getToken:async()=>result}});
    assert.equal((await providers.analytics.submit({targetId,attempt:1})).errorCode,'provider_authentication_required');assert.equal(calls.length,0);
  }
  const {providers,calls}=setup({tokenProvider:{getToken:async()=>{throw Error('secret key is abc');}}});
  const result=await providers.analytics.submit({targetId,attempt:1});assert.equal(result.errorCode,'provider_authentication_required');
  assert(!JSON.stringify(result).includes('abc'));assert.equal(calls.length,0);
});
for(const [status,code,state] of [[400,'provider_request_rejected','operator_action_required'],[401,'provider_authentication_required','operator_action_required'],
  [403,'provider_permission_denied','operator_action_required'],[404,'provider_request_rejected','operator_action_required'],[408,'provider_timeout','retry_wait'],
  [429,'rate_limited','retry_wait'],[500,'provider_unavailable','retry_wait'],[503,'provider_unavailable','retry_wait'],[302,'provider_request_rejected','operator_action_required'],
  [204,'provider_request_rejected','operator_action_required']]) test(`normalizes HTTP ${status} without copying error body`,async()=>{
    const response=new Response(status===204?null:'secret identifier and token',{status,headers:{'retry-after':'120'}});
    const {providers}=setup({response});const result=await providers.analytics.submit({targetId,attempt:1});
    assert.equal(result.state,state);assert.equal(result.errorCode,code);assert(!JSON.stringify(result).includes('secret'));
    if(state==='retry_wait')assert(Date.parse(result.nextRetryAt)>=FIXTURE_NOW+120000);
  });
test('Retry-After seconds and date are floors, even beyond configured backoff maximum',async()=>{
  const times=['120','Wed, 07 Oct 2026 00:00:00 GMT','999999999999999999999999'];
  for(const header of times) {
    const {providers}=setup({response:json({},429,{'retry-after':header})});const result=await providers.analytics.submit({targetId,attempt:50});
    if(header.startsWith('999'))assert.equal(result.errorCode,'invalid_retry_schedule');
    else assert(Date.parse(result.nextRetryAt)>= (header==='120'?FIXTURE_NOW+config.google.retryMaxMs:Date.parse(header)));
  }
});
test('missing/invalid Retry-After uses exponential jittered backoff',async()=>{
  const settings=config.google;
  for(const retryAfter of [null,'-1','1.5','nonsense','Wed, 30 Feb 2026 00:00:00 GMT']) {
    const result=normalizeProviderResponse('analytics',{status:429,retryAfter},{nowMs:FIXTURE_NOW,attempt:2,settings,jitter:()=>0});
    assert.equal(Date.parse(result.nextRetryAt),FIXTURE_NOW+45000);
  }
});
for(const body of [null,{},[],{deletionRequestTime:null},{deletionRequestTime:'2026-02-30T00:00:00Z'},
  {deletionRequestTime:'2026-10-04'},{deletionRequestTime:'2026-10-04T24:00:00Z'},{deletionRequestTime:'0000-01-01T00:00:00Z'},
  {deletionRequestTime:'2026-10-04T00:00:00-00:00'},{targetCompleteTime:'2026-10-05T00:00:00Z'},
  {...success.analytics,token:'secret'}, {...success.analytics,error:'failed'}])
  test(`unknown/missing/malformed success body is never submitted: ${JSON.stringify(body)}`,async()=>{
    const {providers}=setup({response:json(body)});assert.equal((await providers.analytics.submit({targetId,attempt:1})).state,'operator_action_required');
  });
test('HTML, oversized body and duplicate timestamp keys are rejected',async()=>{
  for(const response of [new Response('<html>ok</html>',{status:200,headers:{'content-type':'text/html'}}),
    new Response('x'.repeat(8193),{status:200,headers:{'content-type':'application/json'}}),
    new Response('{"deletionRequestTime":"2026-10-04T00:00:00Z","deletionRequestTime":"2026-10-04T00:01:00Z"}',{status:200,headers:{'content-type':'application/json'}})]) {
    const {providers}=setup({response});assert.equal((await providers.analytics.submit({targetId,attempt:1})).errorCode,'invalid_provider_json');
  }
});
test('network failures, token stalls, fetch stalls and body stalls all have bounded retries',async()=>{
  const quick={...config,google:{...config.google,timeoutMs:5}};
  const options=[{fetcher:async()=>{throw Error('secret detail');}},
    {tokenProvider:{getToken:async()=>new Promise(()=>{})}},
    {fetcher:async()=>new Promise(()=>{})},
    {fetcher:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})}];
  for(const option of options) {
    const {providers}=setup({config:quick,...option});const result=await providers.analytics.submit({targetId,attempt:1});
    assert.equal(result.state,'retry_wait');assert(['provider_timeout','provider_unavailable'].includes(result.errorCode));
    assert(!JSON.stringify(result).includes('secret'));
  }
});
test('aborted token acquisition cannot cause late network call',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const {providers,calls}=setup({config:{...config,google:{...config.google,timeoutMs:5}},tokenProvider:{getToken:()=>pending}});
  assert.equal((await providers.analytics.submit({targetId,attempt:1})).errorCode,'provider_timeout');
  release(token);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls.length,0);
});
test('success remains submission-only even if targetCompleteTime has passed',async()=>{
  const {providers}=setup({response:json({targetCompleteTime:'2026-10-03T00:00:00Z'})});
  const result=await providers.crashlytics.submit({targetId:crashId,attempt:1});assert.equal(result.state,'submitted');assert.equal(result.completionEvidence,'submission_only');
});
test('timestamp helper rejects normalized invalid dates and validates calendar/leap/offset fields',()=>{
  for(const value of ['2024-02-29T12:34:56Z','2026-10-04T12:34:56.123456789+05:30'])assert.equal(isStrictTimestamp(value),true);
  for(const value of ['2026-02-29T00:00:00Z','2024-13-01T00:00:00Z','2026-10-04T00:00:60Z','2026-10-04T00:00:00+24:00',42])assert.equal(isStrictTimestamp(value),false);
});
test('pure normalizer rejects invalid status/clock/settings without throwing',()=>{
  const valid={nowMs:FIXTURE_NOW,attempt:1,settings:config.google};
  for(const status of ['500',0,600,NaN])assert.equal(normalizeProviderResponse('analytics',{status},valid).errorCode,'invalid_provider_response');
  assert.equal(normalizeProviderResponse('mlkit',{status:200},valid).errorCode,'unsupported_provider');
  assert.equal(normalizeProviderResponse('analytics',{status:200},{...valid,nowMs:NaN}).state,'operator_action_required');
  assert.equal(normalizeProviderResponse('analytics',{status:429},{...valid,jitter:()=>2}).errorCode,'invalid_retry_schedule');
});
test('Retry-After delay starts at receipt, not before the provider call',async()=>{
  let now=FIXTURE_NOW;
  const {providers}=setup({now:()=>now,fetcher:async()=>{now+=10000;return json({},429,{'retry-after':'120'});}});
  assert.equal(Date.parse((await providers.analytics.submit({targetId,attempt:1})).nextRetryAt),FIXTURE_NOW+130000);
});
