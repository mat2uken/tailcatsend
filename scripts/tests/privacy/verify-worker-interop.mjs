import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {createAuth, jwkThumbprint} from '../../../services/diagnostics-deletion/src/auth.mjs';
import {APP_CHECK_JWKS_URL} from '../../../services/diagnostics-deletion/src/config.mjs';
const fixture = JSON.parse(await readFile(process.argv[2]));
const auth = createAuth({config:{audience:'https://privacy.example.invalid',
  appCheck:{jwksUrl:APP_CHECK_JWKS_URL},retention:{nonceTtlSeconds:300},limits:{maxBodyBytes:8192}},
  crypto:webcrypto, now:()=>1791091200000, fetcher:()=>{throw Error('network forbidden');}});
const input = {proof:fixture.proof,method:'POST',path:'/v1/requests',bodyBytes:new TextEncoder().encode('{"schemaVersion":1}'),
  challenge:{challengeId:'chg_fixture',nonce:'nonce_fixture',ownerKey:fixture.kid,method:'POST',path:'/v1/requests',expiresAt:1791091260000},
  publicJwk:fixture.publicJwk,epochId:'epoch_fixture',expectedKid:fixture.kid};
assert.equal(await jwkThumbprint(fixture.publicJwk,webcrypto),fixture.kid);
assert.equal((await auth.verifyProof(input)).ok,true,'actual Worker verifies Java JCA signature');
assert.equal((await auth.verifyProof({...input,bodyBytes:new TextEncoder().encode('{}')})).ok,false);
assert.equal((await auth.verifyProof({...input,epochId:'other_epoch'})).ok,false);
assert.equal((await auth.verifyProof({...input,path:'/v1/enrollments'})).ok,false);
assert.equal((await auth.verifyProof({...input,expectedKid:'other_key'})).ok,false);
console.log('PASS: 6 Java→Worker WebCrypto interoperability checks; zero network calls');
