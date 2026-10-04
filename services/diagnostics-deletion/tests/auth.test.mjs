import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createAuth, jwkThumbprint, validatePublicJwk, bodySha256} from '../src/auth.mjs';
import {readConfig, APP_CHECK_JWKS_URL} from '../src/config.mjs';
import {FIXTURE_ENV} from './fixtures/config.mjs';
const f = JSON.parse(readFileSync(new URL('./fixtures/auth-signatures.json',import.meta.url)));
const config = readConfig(FIXTURE_ENV);
const bytes = new TextEncoder().encode(f.body);
const noNetwork = async () => { throw new Error('network must not run'); };
const input = () => ({proof:f.proofs.valid,method:'POST',path:'/v1/requests',bodyBytes:bytes,
  challenge:structuredClone(f.challenge),publicJwk:f.publicJwk,epochId:f.payload.epochId,expectedKid:f.kid});
const auth = overrides => createAuth({config,crypto:webcrypto,fetcher:noNetwork,now:()=>f.now,...overrides});
const reject = result => {assert.equal(result.ok,false); assert.match(result.code,/^(invalid_proof|expired_challenge|app_attestation_rejected)$/);};

test('standard RFC7638 thumbprint ignores input member order but rejects extensions/private keys',async()=>{
  assert.equal(await jwkThumbprint(f.publicJwk,webcrypto),f.kid);
  assert.equal(await jwkThumbprint({y:f.publicJwk.y,x:f.publicJwk.x,crv:'P-256',kty:'EC'},webcrypto),f.kid);
  for(const key of [{...f.publicJwk,d:'secret'},{...f.publicJwk,alg:'ES256'},{...f.publicJwk,crv:'P-384'},{...f.publicJwk,x:f.publicJwk.x+'='},{...f.publicJwk,x:'A'.repeat(42)},null]) {
    assert.equal(validatePublicJwk(key),false); await assert.rejects(jwkThumbprint(key,webcrypto),/invalid_public_key/);
  }
  assert.equal(await bodySha256(bytes,webcrypto),f.payload.bodySha256);
});
test('real ES256 signature verifies and does not consume or mutate challenge',async()=>{
  const value=input(); const original=structuredClone(value.challenge);
  assert.deepEqual(await auth().verifyProof(value),{ok:true,ownerKey:f.kid,challengeId:f.challenge.challengeId,nonce:f.challenge.nonce});
  assert.deepEqual(value.challenge,original); assert.equal((await auth().verifyProof(value)).ok,true);
});
for(const [name,proof]of Object.entries(f.proofs).filter(([name])=>!['valid','enrollment','get'].includes(name)))
  test(`rejects signed proof vector ${name}`,async()=>reject(await auth().verifyProof({...input(),proof})));
test('registration proof has no epoch; post-registration requires stored epoch',async()=>{
  const value={...input(),proof:f.proofs.enrollment,path:'/v1/enrollments',challenge:{...f.challenge,path:'/v1/enrollments'}};
  delete value.epochId;
  assert.equal((await auth().verifyProof(value)).ok,true);
  reject(await auth().verifyProof({...value,epochId:'epoch_fixture_alpha'}));
});
test('GET uses empty request bytes',async()=>{
  const path='/v1/requests/11111111-1111-4111-8111-111111111111';
  assert.equal((await auth().verifyProof({...input(),proof:f.proofs.get,method:'GET',path,bodyBytes:new Uint8Array(),challenge:{...f.challenge,method:'GET',path}})).ok,true);
});
test('bytes, routing header, method, path, challenge binding and stored key are mandatory',async()=>{
  for(const change of [
    {bodyBytes:new TextEncoder().encode(f.body+' ')},{expectedKid:undefined},{expectedKid:'other'},
    {method:'GET'},{path:'/v1/enrollments'},{path:'/v1/requests?foo=bar'},{path:'/v1/requests#hash'},
    {challenge:{...f.challenge,ownerKey:'other'}},{challenge:{...f.challenge,method:'GET'}},
    {challenge:{...f.challenge,path:'/v1/enrollments'}},{challenge:{...f.challenge,nonce:'other'}},
    {challenge:{...f.challenge,expiresAt:f.now+301000}},{publicJwk:{...f.publicJwk,x:'A'.repeat(43)}},
    {proof:f.proofs.valid.slice(0,-8)+'AAAAAAAA'},{proof:f.proofs.valid+'.extra'},{proof:'none'},
    {bodyBytes:new Uint8Array(8193)},
  ]) reject(await auth().verifyProof({...input(),...change}));
});
test('expired challenge fails even if signature is valid',async()=>{
  assert.equal((await auth({now:()=>f.now+300000}).verifyProof(input())).code,'expired_challenge');
});
const jsonResponse = body => new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
function jwksAuth(extra={}) {
  const calls=[];
  const verifier=auth({fetcher:async(url,options)=>{calls.push({url,options});return jsonResponse({keys:[f.rsaJwk]});},...extra});
  return {verifier,calls};
}
test('real RS256 App Check verifies fixed issuer/audience/Android app and fetches approved URL once',async()=>{
  const {verifier,calls}=jwksAuth();
  assert.deepEqual(await verifier.verifyAppCheck(f.appTokens.valid),{ok:true,appId:f.appPayload.sub});
  assert.equal((await verifier.verifyAppCheck(f.appTokens.valid)).ok,true);
  assert.equal(calls.length,1); assert.equal(calls[0].url,APP_CHECK_JWKS_URL);assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.headers.Authorization,undefined);
});
for(const [name,token]of Object.entries(f.appTokens).filter(([name])=>name!=='valid'))
  test(`rejects signed App Check vector ${name}`,async()=>reject(await jwksAuth().verifier.verifyAppCheck(token)));
test('tampered signature and unknown kid rejected; unknown kid cannot amplify fetches',async()=>{
  const {verifier,calls}=jwksAuth();
  reject(await verifier.verifyAppCheck(f.appTokens.valid.slice(0,-8)+'AAAAAAAA'));
  for(let i=0;i<5;i++)reject(await verifier.verifyAppCheck(f.appTokens.header_kid));
  assert.equal(calls.length,1);
});
test('JWKS cache is bounded and refreshed after configured expiry',async()=>{
  let now=f.now; const {verifier,calls}=jwksAuth({now:()=>now});
  await verifier.verifyAppCheck(f.appTokens.valid);
  // Expired JWT is rejected without fetching; fresh timestamp uses a shorter test cache.
  const short={...config,appCheck:{...config.appCheck,jwksCacheSeconds:1}};
  const other=jwksAuth({config:short,now:()=>now});
  await other.verifier.verifyAppCheck(f.appTokens.valid);now+=1001;
  assert.equal((await other.verifier.verifyAppCheck(f.appTokens.valid)).ok,true);assert.equal(other.calls.length,2);assert.equal(calls.length,1);
});
test('untrusted JWKS URLs and malformed/duplicate/private/weak keys fail closed',async()=>{
  let calls=0; const fetcher=async()=>{calls++;throw Error('must not fetch');};
  reject(await auth({config:{...config,appCheck:{...config.appCheck,jwksUrl:'https://other.example.test'}},fetcher}).verifyAppCheck(f.appTokens.valid));assert.equal(calls,0);
  for(const body of [{keys:[]},{keys:[f.rsaJwk,f.rsaJwk]},{keys:[{...f.rsaJwk,d:'secret'}]},
    {keys:[{...f.rsaJwk,kty:'EC'}]},{keys:[{...f.rsaJwk,n:'A'.repeat(43)}]},{keys:[{...f.rsaJwk,e:'Aw'}]}]) {
    reject(await auth({fetcher:async()=>jsonResponse(body)}).verifyAppCheck(f.appTokens.valid));
  }
});
test('JWKS malformed JSON, oversized stream, redirects and timeouts never expose raw errors',async()=>{
  for(const fetcher of [async()=>new Response('secret',{status:200}),
    async()=>new Response('x'.repeat(65537),{status:200,headers:{'content-type':'application/json'}}),
    async()=>new Response(null,{status:302,headers:{location:'https://other.example.test'}}),
    async()=>{throw Error('Bearer secret token');},async()=>new Promise(()=>{})]) {
    const c={...config,appCheck:{...config.appCheck,timeoutMs:5}};
    const result=await auth({config:c,fetcher}).verifyAppCheck(f.appTokens.valid);reject(result);assert(!JSON.stringify(result).includes('secret'));
  }
});
test('JWT expiry is rechecked after a slow JWKS fetch',async()=>{
  let now=f.now;
  const verifier=auth({now:()=>now,fetcher:async()=>{now=f.appPayload.exp*1000;return jsonResponse({keys:[f.rsaJwk]});}});
  reject(await verifier.verifyAppCheck(f.appTokens.valid));
});
test('proof expiry is rechecked after asynchronous crypto verification',async()=>{
  let now=f.now;
  const crypto={subtle:{
    digest:(...args)=>webcrypto.subtle.digest(...args),
    importKey:(...args)=>webcrypto.subtle.importKey(...args),
    verify:async(...args)=>{const result=await webcrypto.subtle.verify(...args);now=f.challenge.expiresAt;return result;},
  }};
  assert.equal((await auth({now:()=>now,crypto}).verifyProof(input())).code,'expired_challenge');
});
