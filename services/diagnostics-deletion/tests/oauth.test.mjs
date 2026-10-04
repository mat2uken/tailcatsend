import test from 'node:test';import assert from 'node:assert/strict';import {createServiceAccountTokenProvider} from '../src/oauth.mjs';
const email='deletion-only@fixture-project.iam.gserviceaccount.com';
// Intentionally not a valid private key. Tests inject the cryptographic provider;
// real signature verification is covered separately with RFC public fixtures.
const privateKeyPem='-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----';
const scopes={analytics:['https://www.googleapis.com/auth/analytics.edit'],crashlytics:['https://www.googleapis.com/auth/firebase']};
function fixture(response=()=>new Response(JSON.stringify({token_type:'Bearer',access_token:'fixture_access_token_not_real',expires_in:3600}),{headers:{'Content-Type':'application/json'}})){
 let time=1791072000000;const calls=[],imports=[],signatures=[];
 const crypto={subtle:{async importKey(...args){imports.push(args);return 'fixture-key-handle';},async sign(...args){signatures.push(args);return new Uint8Array(256).buffer;}}};
 const provider=createServiceAccountTokenProvider({email,privateKeyPem,crypto,now:()=>time,fetcher:async(url,options)=>{calls.push({url,options});return response();}});
 return {provider,calls,imports,signatures,advance(ms){time+=ms;}};
}
test('unconfigured token provider fails without imports, signing or network',async()=>{
 let called=false;const p=createServiceAccountTokenProvider({fetcher:()=>{called=true;}});assert.equal(p.configured,false);await assert.rejects(()=>p.getToken('analytics',{scopes:scopes.analytics}),/token_unavailable/);assert.equal(called,false);
});
test('service-account assertion uses fixed token endpoint, exact provider scope and bounded lifetime',async()=>{
 const h=fixture();await h.provider.getToken('analytics',{scopes:scopes.analytics});assert.equal(h.calls.length,1);const {url,options}=h.calls[0];assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,undefined);
 const params=new URLSearchParams(options.body);assert.equal(params.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');const [header,payload]=params.get('assertion').split('.').slice(0,2).map(s=>JSON.parse(Buffer.from(s,'base64url').toString()));assert.deepEqual(header,{alg:'RS256',typ:'JWT'});assert.equal(payload.scope,scopes.analytics[0]);assert.equal(payload.iss,email);assert.equal(payload.exp-payload.iat,3600);assert.equal(h.imports[0][3],false);assert.deepEqual(h.imports[0][4],['sign']);
});
test('tokens cache separately by provider and refresh before expiry',async()=>{
 const h=fixture();await h.provider.getToken('analytics',{scopes:scopes.analytics});await h.provider.getToken('analytics',{scopes:scopes.analytics});assert.equal(h.calls.length,1);await h.provider.getToken('crashlytics',{scopes:scopes.crashlytics});assert.equal(h.calls.length,2);h.advance(3540000);await h.provider.getToken('analytics',{scopes:scopes.analytics});assert.equal(h.calls.length,3);assert.equal(h.imports.length,1);
});
test('broader or caller-selected scopes are rejected',async()=>{
 const h=fixture();for(const value of [['https://www.googleapis.com/auth/cloud-platform'],[...scopes.analytics,...scopes.crashlytics],[]])await assert.rejects(()=>h.provider.getToken('analytics',{scopes:value}),/token_unavailable/);assert.equal(h.calls.length,0);assert.equal(h.imports.length,0);
});
test('aborted request never signs or sends assertion',async()=>{
 const h=fixture();const controller=new AbortController();controller.abort();await assert.rejects(()=>h.provider.getToken('analytics',{scopes:scopes.analytics,signal:controller.signal}),/token_unavailable/);assert.equal(h.calls.length,0);assert.equal(h.signatures.length,0);
});
test('token response errors, malformed or huge bodies, redirects and unsafe tokens never escape',async()=>{
 for(const response of [()=>new Response('private_error',{status:403}),()=>new Response('not json',{headers:{'Content-Type':'application/json'}}),()=>new Response('x'.repeat(16385),{headers:{'Content-Type':'application/json'}}),()=>new Response(JSON.stringify({token_type:'Bearer',access_token:'private\nheader',expires_in:3600}),{headers:{'Content-Type':'application/json'}}),()=>new Response(JSON.stringify({token_type:'Bearer',access_token:'fixture_access_token',expires_in:999999}),{headers:{'Content-Type':'application/json'}})]){
 const h=fixture(response);await assert.rejects(()=>h.provider.getToken('analytics',{scopes:scopes.analytics}),error=>error.message==='token_unavailable');}
});
