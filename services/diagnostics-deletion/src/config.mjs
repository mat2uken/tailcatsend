/** All deployment choices are explicit. No credential or token is read here. */
export const APP_CHECK_JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks';

export class ConfigError extends Error {
  constructor() { super('not_configured'); this.name = 'ConfigError'; this.code = 'not_configured'; }
}
const fail = () => { throw new ConfigError(); };
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** Missing values, including retention choices, fail closed with one sanitized error. */
export function readConfig(env = {}) {
  try {
    const text = (key, pattern) => {
      const value = env[key];
      if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
          value.length > 2048 || (pattern && !pattern.test(value))) fail();
      return value;
    };
    const integer = (key, min, max) => {
      const value = text(key, /^(?:0|[1-9]\d*)$/);
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < min || number > max) fail();
      return number;
    };
    const boolean = (key) => {
      const value = text(key);
      if (value !== 'true' && value !== 'false') fail();
      return value === 'true';
    };
    const enabled = boolean('DELETION_ENABLED');
    const googleAdapterMode = text('GOOGLE_ADAPTER_MODE', /^(live|disabled|fixture)$/);
    const audience = text('DELETION_AUDIENCE');
    const url = new URL(audience);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || url.origin !== audience) fail();
    const policyVersion = text('DELETION_POLICY_VERSION', /^[a-zA-Z0-9_-]{1,80}$/);
    const limits = {
      maxBodyBytes: integer('MAX_BODY_BYTES', 1, 8192),
      bodyReadTimeoutMs: integer('MAX_BODY_READ_MS', 1, 30000),
      maxChallenges: integer('MAX_CHALLENGES', 1, 1000),
      maxChallengesPerWindow: integer('MAX_CHALLENGES_PER_WINDOW', 1, 1000),
      challengeWindowMs: integer('CHALLENGE_WINDOW_MS', 1000, 86400000),
    };
    const retention = {
      nonceTtlSeconds: integer('NONCE_TTL_SECONDS', 1, 900),
      receiptDays: integer('RECEIPT_RETENTION_DAYS', 1, 3650),
      mappingDays: integer('MAPPING_RETENTION_DAYS', 1, 3650),
      backupDays: integer('BACKUP_RETENTION_DAYS', 0, 3650),
      retiredKeyPolicy: text('RETIRED_KEY_POLICY', /^retain_tombstone$/),
    };
    // Keep mappings at least as long as the promised receipt access period.
    if (retention.mappingDays < retention.receiptDays) fail();
    const projectNumber = text('APP_CHECK_PROJECT_NUMBER', /^[1-9]\d{0,19}$/);
    const appIds = JSON.parse(text('APP_CHECK_APP_IDS'));
    if (!Array.isArray(appIds) || appIds.length !== 1 ||
        new Set(appIds).size !== appIds.length || appIds.some(id => typeof id !== 'string' ||
        !new RegExp(`^1:${projectNumber}:android:[a-fA-F0-9]{8,64}$`).test(id))) fail();
    const jwksUrl = text('APP_CHECK_JWKS_URL');
    if (jwksUrl !== APP_CHECK_JWKS_URL) fail();
    const appCheck = {
      projectNumber, appIds, jwksUrl,
      jwksCacheSeconds: integer('APP_CHECK_JWKS_CACHE_SECONDS', 1, 21600),
      maxTokenTtlSeconds: integer('APP_CHECK_MAX_TOKEN_TTL_SECONDS', 1, 604800),
      clockSkewSeconds: integer('APP_CHECK_CLOCK_SKEW_SECONDS', 0, 300),
      timeoutMs: integer('APP_CHECK_TIMEOUT_MS', 1, 30000),
    };
    const google = {
      analyticsPropertyId: text('ANALYTICS_PROPERTY_ID', /^[1-9]\d{0,19}$/),
      crashlyticsProjectNumber: text('CRASHLYTICS_PROJECT_NUMBER', /^[1-9]\d{0,19}$/),
      crashlyticsAppId: text('CRASHLYTICS_APP_ID', /^1:[1-9]\d{0,19}:android:[a-fA-F0-9]{8,64}$/),
      crashlyticsIamVerified: boolean('CRASHLYTICS_MINIMAL_IAM_VERIFIED'),
      timeoutMs: integer('GOOGLE_TIMEOUT_MS', 1, 30000),
      retryBaseMs: integer('GOOGLE_RETRY_BASE_MS', 1, 3600000),
      retryMaxMs: integer('GOOGLE_RETRY_MAX_MS', 1, 86400000),
    };
    if (google.crashlyticsProjectNumber !== projectNumber || !appIds.includes(google.crashlyticsAppId) ||
        google.retryMaxMs < google.retryBaseMs) fail();
    const jobs = {leaseMs: integer('JOB_LEASE_MS', 1, 300000)};
    // One call's entire token/fetch/body timeout must fit inside a job's lease.
    if (jobs.leaseMs <= google.timeoutMs) fail();
    return freeze({enabled, googleAdapterMode, audience, policyVersion, limits, retention, appCheck, google, jobs});
  } catch { throw new ConfigError(); }
}
