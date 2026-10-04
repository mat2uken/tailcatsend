/** Live-capable adapters. Network and token acquisition are injected in every test. */
export const GOOGLE_SCOPES = Object.freeze({
  analytics: Object.freeze(['https://www.googleapis.com/auth/analytics.edit']),
  crashlytics: Object.freeze(['https://www.googleapis.com/auth/firebase']),
});
const FIELD = Object.freeze({analytics: 'deletionRequestTime', crashlytics: 'targetCompleteTime'});
const MAX_BODY = 8192;
const MAX_DATE = 253402300799999;
const decoder = new TextDecoder('utf-8', {fatal: true});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const operator = errorCode => ({state: 'operator_action_required', errorCode, completionEvidence: 'none'});
const validClock = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;

export function isStrictTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, minute, s, , zone] = match;
  const [year, month, day, hour, min, second] = [y, m, d, h, minute, s].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || min > 59 || second > 59) return false;
  if (zone !== 'Z' && (zone === '-00:00' || Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= -62135596800000 && parsed <= MAX_DATE;
}
function retryAfterAt(raw, nowMs) {
  if (typeof raw !== 'string') return nowMs;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds > Math.floor((MAX_DATE - nowMs) / 1000)) return Infinity;
    return nowMs + seconds * 1000;
  }
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value) return Math.max(nowMs, timestamp);
  }
  return nowMs;
}
function retry(errorCode, retryAfter, nowMs, attempt, settings, jitter) {
  const random = jitter();
  if (!Number.isFinite(random) || random < 0 || random > 1) return operator('invalid_retry_schedule');
  const backoff = Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.min(attempt - 1, 30));
  const delay = Math.ceil(backoff * (0.75 + 0.25 * random));
  const next = Math.max(nowMs + delay, retryAfterAt(retryAfter, nowMs));
  if (!validClock(next)) return operator('invalid_retry_schedule');
  return {state: 'retry_wait', errorCode, nextRetryAt: new Date(next).toISOString(), completionEvidence: 'none'};
}

/** Only enumerated codes and the one documented timestamp ever escape the adapter. */
export function normalizeProviderResponse(provider, response, {nowMs, attempt, settings, jitter = () => 1} = {}) {
  if (!Object.hasOwn(FIELD, provider)) return operator('unsupported_provider');
  if (!validClock(nowMs) || !Number.isSafeInteger(attempt) || attempt < 1) return operator('invalid_attempt');
  if (!record(settings) || !Number.isSafeInteger(settings.retryBaseMs) || settings.retryBaseMs < 1 ||
      !Number.isSafeInteger(settings.retryMaxMs) || settings.retryMaxMs < settings.retryBaseMs) return operator('not_configured');
  if (!record(response)) return operator('invalid_provider_response');
  try {
    if (response.timeout === true) return retry('provider_timeout', null, nowMs, attempt, settings, jitter);
    if (response.networkError === true) return retry('provider_unavailable', null, nowMs, attempt, settings, jitter);
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) return operator('invalid_provider_response');
    if (response.status === 429) return retry('rate_limited', response.retryAfter, nowMs, attempt, settings, jitter);
    if (response.status === 408) return retry('provider_timeout', response.retryAfter, nowMs, attempt, settings, jitter);
    if (response.status >= 500 && response.status <= 599) return retry('provider_unavailable', response.retryAfter, nowMs, attempt, settings, jitter);
    if (response.status === 401) return operator('provider_authentication_required');
    if (response.status === 403) return operator('provider_permission_denied');
    if (response.status !== 200) return operator('provider_request_rejected');
    if (response.invalidJson) return operator('invalid_provider_json');
    const body = response.body;
    const field = FIELD[provider];
    if (!record(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, field)) return operator('invalid_provider_response');
    if (!isStrictTimestamp(body[field])) return operator('invalid_provider_timestamp');
    return {state: 'submitted', [field]: body[field], completionEvidence: 'submission_only'};
  } catch { return operator('invalid_provider_response'); }
}

async function responseBody(response, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new Error();
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks = []; let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const {done, value} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY) throw new Error();
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  const text = decoder.decode(bytes);
  const parsed = JSON.parse(text);
  // The success document contains exactly one scalar string. Requiring this shape
  // also rules out duplicated keys (JSON.parse alone would silently keep the last).
  if (!/^\s*\{\s*"(?:deletionRequestTime|targetCompleteTime)"\s*:\s*"[^"\\]*"\s*\}\s*$/.test(text)) throw new Error();
  return parsed;
}

/** TokenProvider: getToken(provider,{scopes,signal}) -> {accessToken,expiresAt:ms}. */
export function createGoogleProviders({config, tokenProvider, fetcher = globalThis.fetch, now = Date.now, jitter = Math.random} = {}) {
  const settings = config?.google;
  const active = config?.enabled === true && config.googleAdapterMode === 'live' && record(settings) &&
    /^[1-9]\d{0,19}$/.test(settings.analyticsPropertyId ?? '') &&
    /^[1-9]\d{0,19}$/.test(settings.crashlyticsProjectNumber ?? '') &&
    new RegExp(`^1:${settings.crashlyticsProjectNumber}:android:[a-fA-F0-9]{8,64}$`).test(settings.crashlyticsAppId ?? '') &&
    Number.isSafeInteger(settings.timeoutMs) && settings.timeoutMs > 0 && settings.timeoutMs <= 30000 &&
    Number.isSafeInteger(settings.retryBaseMs) && settings.retryBaseMs > 0 &&
    Number.isSafeInteger(settings.retryMaxMs) && settings.retryMaxMs >= settings.retryBaseMs &&
    typeof tokenProvider?.getToken === 'function' && typeof fetcher === 'function' && typeof now === 'function';
  const make = provider => Object.freeze({
    mode: active ? 'live' : 'disabled',
    enabled: Boolean(active && (provider !== 'crashlytics' || settings.crashlyticsIamVerified === true)),
    async submit({targetId, attempt} = {}) {
      if (!active) return operator('not_configured');
      if (provider === 'crashlytics' && settings.crashlyticsIamVerified !== true)
        return {state: 'unsupported', errorCode: 'permission_verification_required', completionEvidence: 'none'};
      if (typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(targetId)) return operator('invalid_target');
      if (!Number.isSafeInteger(attempt) || attempt < 1) return operator('invalid_attempt');
      let nowMs;
      try { nowMs = now(); } catch { return operator('invalid_clock'); }
      if (!validClock(nowMs)) return operator('invalid_clock');
      const normalize = response => {
        let receivedAt;
        try { receivedAt = now(); } catch { return operator('invalid_clock'); }
        if (!validClock(receivedAt)) return operator('invalid_clock');
        return normalizeProviderResponse(provider, response, {nowMs: receivedAt, attempt, settings, jitter});
      };
      const controller = new AbortController(); let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve(normalize({timeout: true}));
      }, settings.timeoutMs); });
      const work = (async () => {
        let token;
        try { token = await tokenProvider.getToken(provider, {scopes: GOOGLE_SCOPES[provider], signal: controller.signal}); }
        catch { return controller.signal.aborted ? normalize({timeout: true}) : operator('provider_authentication_required'); }
        if (controller.signal.aborted) return normalize({timeout: true});
        const tokenCheckedAt = now();
        if (!validClock(tokenCheckedAt)) return operator('invalid_clock');
        if (!record(token) || typeof token.accessToken !== 'string' || token.accessToken.length > 8192 ||
            !/^[A-Za-z0-9._~+\/-]+=*$/.test(token.accessToken) || !validClock(token.expiresAt) ||
            token.expiresAt <= tokenCheckedAt + settings.timeoutMs) return operator('provider_authentication_required');
        const url = provider === 'analytics'
          ? `https://analyticsadmin.googleapis.com/v1alpha/properties/${settings.analyticsPropertyId}:submitUserDeletion`
          : `https://firebasecrashlytics.googleapis.com/v1alpha/projects/${settings.crashlyticsProjectNumber}/apps/${encodeURIComponent(settings.crashlyticsAppId)}/users/${targetId}/crashReports`;
        const headers = {Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json'};
        const request = {method: provider === 'analytics' ? 'POST' : 'DELETE', headers, redirect: 'error', signal: controller.signal};
        if (provider === 'analytics') { headers['Content-Type'] = 'application/json'; request.body = JSON.stringify({userId: targetId}); }
        let response;
        try { response = await fetcher(url, request); }
        catch { return controller.signal.aborted ? normalize({timeout: true}) : normalize({networkError: true}); }
        if (controller.signal.aborted) return normalize({timeout: true});
        if (!response || response.redirected || (response.url && response.url !== url) ||
            !Number.isInteger(response.status) || !response.headers?.get) return operator('invalid_provider_response');
        const summary = {status: response.status, retryAfter: response.headers.get('retry-after')};
        if (response.status === 200) {
          try { summary.body = await responseBody(response, controller.signal); }
          catch { summary.invalidJson = true; }
        } else {
          // Never read Google error bodies, which could contain tokens or identifiers.
          void response.body?.cancel().catch(() => {});
        }
        if (controller.signal.aborted) return normalize({timeout: true});
        return normalize(summary);
      })().catch(() => operator('invalid_provider_response'));
      try { return await Promise.race([work, timeout]); }
      finally { clearTimeout(timer); }
    },
  });
  return Object.freeze({mode: active ? 'live' : 'disabled', analytics: make('analytics'), crashlytics: make('crashlytics')});
}
