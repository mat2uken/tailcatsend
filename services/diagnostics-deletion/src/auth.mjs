import {APP_CHECK_JWKS_URL} from './config.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const rejectProof = () => ({ok: false, status: 401, code: 'invalid_proof'});
const rejectApp = () => ({ok: false, status: 403, code: 'app_attestation_rejected'});
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error();
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error();
  return bytes;
}

// Reject duplicate member names, even escaped duplicates, before JSON.parse.
// The scanner also bounds nesting. JSON.parse remains the syntax authority.
function strictJson(text) {
  const stack = []; let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '"') {
      const start = at++;
      while (at < text.length && text[at] !== '"') { if (text[at] === '\\') at++; at++; }
      if (at >= text.length) throw new Error();
      const token = text.slice(start, ++at);
      let next = at; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const names = stack.at(-1);
        if (!(names instanceof Set)) throw new Error();
        const key = JSON.parse(token);
        if (names.has(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error();
        names.add(key);
      }
    } else {
      if (char === '{') stack.push(new Set());
      else if (char === '[') stack.push(null);
      else if (char === '}' || char === ']') stack.pop();
      if (stack.length > 8) throw new Error();
      at++;
    }
  }
  const parsed = JSON.parse(text);
  if (!record(parsed)) throw new Error();
  return parsed;
}
function compactJws(token) {
  if (typeof token !== 'string' || token.length > 16384) throw new Error();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0].length > 2048 || parts[1].length > 12288) throw new Error();
  return {header: strictJson(decoder.decode(decode64(parts[0]))),
    payload: strictJson(decoder.decode(decode64(parts[1]))),
    signature: decode64(parts[2]), signingInput: encoder.encode(`${parts[0]}.${parts[1]}`)};
}

/** Strict public-only P-256 JWK; actual point validation is WebCrypto import's job. */
export function validatePublicJwk(jwk) {
  try {
    return exactKeys(jwk, ['kty', 'crv', 'x', 'y']) && jwk.kty === 'EC' && jwk.crv === 'P-256' &&
      decode64(jwk.x).length === 32 && decode64(jwk.y).length === 32;
  } catch { return false; }
}
export async function jwkThumbprint(jwk, crypto = globalThis.crypto) {
  if (!validatePublicJwk(jwk)) throw new TypeError('invalid_public_key');
  // RFC 7638 lexicographic required-member order, no whitespace.
  const canonical = JSON.stringify({crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y});
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))));
}
export async function bodySha256(bodyBytes, crypto = globalThis.crypto) {
  if (!(bodyBytes instanceof Uint8Array)) throw new TypeError('invalid_body');
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bodyBytes)));
}

async function readLimitedJson(response, maxBytes, signal) {
  if (!response || response.status !== 200 || response.redirected ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error();
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const pieces = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error();
      pieces.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let cursor = 0;
  for (const part of pieces) { bytes.set(part, cursor); cursor += part.length; }
  return strictJson(decoder.decode(bytes));
}

/** Verifies signatures only. The coordinator atomically consumes a verified nonce. */
export function createAuth({config, fetcher = globalThis.fetch, crypto = globalThis.crypto, now = Date.now} = {}) {
  let cachedKeys = null; let cacheExpiresAt = 0; let pendingJwks = null;
  const configValid = () => config?.appCheck?.jwksUrl === APP_CHECK_JWKS_URL &&
    typeof config.audience === 'string' && Number.isSafeInteger(config.retention?.nonceTtlSeconds) &&
    typeof fetcher === 'function' && typeof now === 'function' && Boolean(crypto?.subtle);

  async function loadKeys() {
    const timestamp = now();
    if (cachedKeys && timestamp < cacheExpiresAt) return cachedKeys;
    if (pendingJwks) return pendingJwks;
    const controller = new AbortController(); let timeout;
    const abort = new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error()); }, config.appCheck.timeoutMs);
    });
    pendingJwks = Promise.race([abort, (async () => {
      const response = await fetcher(APP_CHECK_JWKS_URL, {method: 'GET', redirect: 'error',
        headers: {Accept: 'application/json'}, signal: controller.signal});
      if (response.url && response.url !== APP_CHECK_JWKS_URL) throw new Error();
      const body = await readLimitedJson(response, 65536, controller.signal);
      if (!exactKeys(body, ['keys']) || !Array.isArray(body.keys) || !body.keys.length || body.keys.length > 20) throw new Error();
      const keys = new Map();
      for (const jwk of body.keys) {
        if (!record(jwk) || jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig' ||
            typeof jwk.kid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(jwk.kid) || keys.has(jwk.kid) ||
            ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'jku', 'x5u'].some(key => Object.hasOwn(jwk, key))) throw new Error();
        const modulus = decode64(jwk.n); const exponent = decode64(jwk.e);
        if (modulus.length < 256 || modulus.length > 512 || modulus[0] < 128 ||
            exponent.length !== 3 || exponent[0] !== 1 || exponent[1] !== 0 || exponent[2] !== 1) throw new Error();
        const key = await crypto.subtle.importKey('jwk', {kty: 'RSA', n: jwk.n, e: jwk.e},
          {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
        keys.set(jwk.kid, key);
      }
      if (controller.signal.aborted) throw new Error();
      cachedKeys = keys; cacheExpiresAt = now() + config.appCheck.jwksCacheSeconds * 1000;
      return keys;
    })()]).finally(() => { clearTimeout(timeout); pendingJwks = null; });
    return pendingJwks;
  }

  return Object.freeze({
    mode: 'live',
    async verifyAppCheck(token) {
      try {
        if (!configValid()) return rejectApp();
        const {header, payload, signature, signingInput} = compactJws(token);
        if (!exactKeys(header, ['alg', 'typ', 'kid']) || header.alg !== 'RS256' || header.typ !== 'JWT' ||
            typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(header.kid)) return rejectApp();
        const settings = config.appCheck; const seconds = Math.floor(now() / 1000);
        if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
            payload.exp <= seconds || payload.iat > seconds + settings.clockSkewSeconds ||
            payload.exp <= payload.iat || payload.exp - payload.iat > settings.maxTokenTtlSeconds ||
            (Object.hasOwn(payload, 'nbf') && (!Number.isSafeInteger(payload.nbf) || payload.nbf > seconds + settings.clockSkewSeconds)) ||
            payload.iss !== `https://firebaseappcheck.googleapis.com/${settings.projectNumber}` ||
            !Array.isArray(payload.aud) || !payload.aud.length || !payload.aud.every(value => typeof value === 'string') ||
            !payload.aud.includes(`projects/${settings.projectNumber}`) ||
            typeof payload.sub !== 'string' || !settings.appIds.includes(payload.sub) ||
            (Object.hasOwn(payload, 'app_id') && payload.app_id !== payload.sub)) return rejectApp();
        const key = (await loadKeys()).get(header.kid);
        // Unknown kid does not force a refetch per request (prevents network amplification).
        if (!key || !await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput)) return rejectApp();
        const verifiedAt = now();
        if (!Number.isSafeInteger(verifiedAt) || payload.exp * 1000 <= verifiedAt) return rejectApp();
        return {ok: true, appId: payload.sub};
      } catch { return rejectApp(); }
    },
    async verifyProof({proof, method, path, bodyBytes, challenge, publicJwk, epochId, expectedKid} = {}) {
      try {
        if (!configValid() || !validatePublicJwk(publicJwk) || !(bodyBytes instanceof Uint8Array) ||
            bodyBytes.length > config.limits.maxBodyBytes || !record(challenge) ||
            !['GET', 'POST'].includes(method) || typeof path !== 'string' || !path.startsWith('/v1/') ||
            /[?#\\\s]/.test(path) || (method === 'GET' && bodyBytes.length !== 0)) return rejectProof();
        const {header, payload, signature, signingInput} = compactJws(proof);
        if (!exactKeys(header, ['alg', 'typ', 'kid']) || header.alg !== 'ES256' || header.typ !== 'ponlet-privacy+jwt' ||
            signature.length !== 64) return rejectProof();
        const fields = ['aud', 'method', 'path', 'bodySha256', 'challengeId', 'nonce', 'exp'];
        if (epochId !== undefined) fields.push('epochId');
        if (!exactKeys(payload, fields)) return rejectProof();
        const ownerKey = await jwkThumbprint(publicJwk, crypto);
        if (header.kid !== ownerKey || expectedKid !== ownerKey || challenge.ownerKey !== ownerKey ||
            challenge.method !== method || challenge.path !== path ||
            typeof challenge.challengeId !== 'string' || !challenge.challengeId ||
            typeof challenge.nonce !== 'string' || !challenge.nonce ||
            payload.aud !== config.audience || payload.method !== method || payload.path !== path ||
            payload.challengeId !== challenge.challengeId || payload.nonce !== challenge.nonce ||
            payload.bodySha256 !== await bodySha256(bodyBytes, crypto) ||
            (epochId !== undefined && (typeof epochId !== 'string' || !epochId || payload.epochId !== epochId)) ||
            !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(challenge.expiresAt)) return rejectProof();
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp)) return rejectProof();
        if (challenge.expiresAt <= timestamp || payload.exp * 1000 <= timestamp)
          return {ok: false, status: 401, code: 'expired_challenge'};
        if (payload.exp * 1000 > challenge.expiresAt ||
            challenge.expiresAt > timestamp + config.retention.nonceTtlSeconds * 1000) return rejectProof();
        const key = await crypto.subtle.importKey('jwk', publicJwk,
          {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
        if (!await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, signature, signingInput)) return rejectProof();
        const verifiedAt = now();
        if (!Number.isSafeInteger(verifiedAt)) return rejectProof();
        if (challenge.expiresAt <= verifiedAt || payload.exp * 1000 <= verifiedAt)
          return {ok: false, status: 401, code: 'expired_challenge'};
        return {ok: true, ownerKey, challengeId: challenge.challengeId, nonce: challenge.nonce};
      } catch { return rejectProof(); }
    },
  });
}
