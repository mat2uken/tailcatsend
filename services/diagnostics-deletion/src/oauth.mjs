/** Optional server-only service-account credential adapter. No credentials are
 * included. Constructing this object never imports a key or calls a network. */
const TOKEN_URL='https://oauth2.googleapis.com/token';
const SCOPES=Object.freeze({analytics:'https://www.googleapis.com/auth/analytics.edit',crashlytics:'https://www.googleapis.com/auth/firebase'});
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const text64=text=>encode(new TextEncoder().encode(text));
function pemBytes(pem){
 if(typeof pem!=='string'||pem.length>16384||!/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\s*$/.test(pem))throw new Error('token_unavailable');
 const b64=pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');
 return Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
}
export function createServiceAccountTokenProvider({email,privateKeyPem,fetcher=globalThis.fetch,crypto=globalThis.crypto,now=Date.now}={}){
 const configured=typeof email==='string'&&/^[a-z0-9][a-z0-9-]{4,62}@[a-z0-9][a-z0-9-]{4,62}\.iam\.gserviceaccount\.com$/.test(email)&&typeof privateKeyPem==='string'&&privateKeyPem.includes('-----BEGIN PRIVATE KEY-----');
 const cache=new Map();let key;
 return {configured,
  async getToken(provider,{scopes,signal}={}){
   try{
    if(!configured||!Object.hasOwn(SCOPES,provider)||!Array.isArray(scopes)||scopes.length!==1||scopes[0]!==SCOPES[provider]||signal?.aborted)throw new Error();
    const saved=cache.get(provider);if(saved&&saved.expiresAt>now()+60000)return {...saved};
    // No stored OAuth refresh token, key generation, or IAM mutation is performed.
    key??=await crypto.subtle.importKey('pkcs8',pemBytes(privateKeyPem),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
    const seconds=Math.floor(now()/1000),header=text64(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const payload=text64(JSON.stringify({iss:email,scope:SCOPES[provider],aud:TOKEN_URL,iat:seconds,exp:seconds+3600}));
    const signingInput=`${header}.${payload}`;const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(signingInput));
    if(signal?.aborted)throw new Error();
    const response=await fetcher(TOKEN_URL,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${signingInput}.${encode(new Uint8Array(signature))}`}).toString()});
    if(response.status!==200||response.redirected||(response.url&&response.url!==TOKEN_URL)||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??''))throw new Error();
    const reader=response.body?.getReader();if(!reader)throw new Error();let size=0;const chunks=[];
    try{for(;;){if(signal?.aborted)throw new Error();const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16384)throw new Error();chunks.push(part.value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let position=0;for(const c of chunks){bytes.set(c,position);position+=c.length;}
    const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(body.token_type!=='Bearer'||typeof body.access_token!=='string'||! /^[A-Za-z0-9._~+\/-]{10,8192}$/.test(body.access_token)||!Number.isSafeInteger(body.expires_in)||body.expires_in<61||body.expires_in>3600||signal?.aborted)throw new Error();
    const result={accessToken:body.access_token,expiresAt:now()+body.expires_in*1000};cache.set(provider,result);return {...result};
   }catch{throw new Error('token_unavailable');}
  },
 };
}
