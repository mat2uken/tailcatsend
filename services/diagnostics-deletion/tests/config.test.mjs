import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig, APP_CHECK_JWKS_URL} from '../src/config.mjs';
import {FIXTURE_ENV} from './fixtures/config.mjs';

test('all deployment choices must be explicit, even when feature disabled', () => {
  for (const field of Object.keys(FIXTURE_ENV)) {
    const env = {...FIXTURE_ENV}; delete env[field];
    assert.throws(() => readConfig(env), {code: 'not_configured', message: 'not_configured'}, field);
  }
  assert.throws(() => readConfig({}), {code: 'not_configured'});
});
test('returns deeply frozen typed configuration, with no secrets', () => {
  const config = readConfig({...FIXTURE_ENV, SECRET: 'not copied'});
  assert.equal(config.enabled, true); assert.equal(config.googleAdapterMode, 'live');
  assert.equal(config.retention.nonceTtlSeconds, 300); assert.equal(config.retention.backupDays, 0);
  assert.equal(config.retention.retiredKeyPolicy, 'retain_tombstone');
  assert.equal(config.appCheck.jwksUrl, APP_CHECK_JWKS_URL);
  assert.equal(config.google.crashlyticsIamVerified, true); assert.equal(config.SECRET, undefined);
  assert(Object.isFrozen(config.appCheck.appIds)); assert(Object.isFrozen(config.retention));
});
test('disabled and fixture settings never silently become live', () => {
  assert.equal(readConfig({...FIXTURE_ENV, DELETION_ENABLED:'false'}).enabled, false);
  assert.equal(readConfig({...FIXTURE_ENV, GOOGLE_ADAPTER_MODE:'fixture'}).googleAdapterMode, 'fixture');
  assert.equal(readConfig({...FIXTURE_ENV, CRASHLYTICS_MINIMAL_IAM_VERIFIED:'false'}).google.crashlyticsIamVerified, false);
});
const invalid = {
  DELETION_ENABLED: ['1',true,'TRUE'], GOOGLE_ADAPTER_MODE:['mock','LIVE',''],
  DELETION_AUDIENCE:['http://privacy.example.test','https://u:p@privacy.example.test','https://privacy.example.test/path','https://privacy.example.test/?token=secret','https://privacy.example.test/'],
  MAX_BODY_BYTES:['8193','0','1e3','+4',' 8'], NONCE_TTL_SECONDS:['0','901'],
  RECEIPT_RETENTION_DAYS:['0','31'], MAPPING_RETENTION_DAYS:['0','29'], BACKUP_RETENTION_DAYS:['-1'],
  RETIRED_KEY_POLICY:['delete',''], APP_CHECK_JWKS_URL:['https://attacker.example.test/jwks',APP_CHECK_JWKS_URL+'?foo=bar'],
  APP_CHECK_APP_IDS:['[]','["1:999:android:0123456789abcdef"]','{}','invalid'],
  APP_CHECK_PROJECT_NUMBER:['abc','01234'], APP_CHECK_JWKS_CACHE_SECONDS:['21601'], APP_CHECK_CLOCK_SKEW_SECONDS:['301'],
  CRASHLYTICS_PROJECT_NUMBER:['999','../123'], CRASHLYTICS_APP_ID:['../../users/id','1:999:android:0123456789abcdef'],
  ANALYTICS_PROPERTY_ID:['properties/123','123/../../other'], GOOGLE_TIMEOUT_MS:['0','30001'],
  GOOGLE_RETRY_BASE_MS:['21600001'], GOOGLE_RETRY_MAX_MS:['1'], JOB_LEASE_MS:['500'],
};
for (const [key, values] of Object.entries(invalid)) test(`rejects invalid ${key} without exposing values`, () => {
  for (const value of values) assert.throws(() => readConfig({...FIXTURE_ENV,[key]:value}), {message:'not_configured',code:'not_configured'});
});
test('multiple Firebase apps cannot share one fixed Crashlytics deletion destination',()=>{
 assert.throws(()=>readConfig({...FIXTURE_ENV,APP_CHECK_APP_IDS:'["1:1234567890:android:0123456789abcdef","1:1234567890:android:fedcba9876543210"]'}),/not_configured/);
});
