import {DatabaseSync} from 'node:sqlite';
/** Local SQLite emulator for the subset of Cloudflare's async KV API used by
 * storage.mjs. This is NOT a Cloudflare runtime/alarms integration test. */
export function sqliteStorage(path=':memory:'){
 const db=new DatabaseSync(path);db.exec('CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
 let serial=Promise.resolve(),failure=null;
 const read=key=>{const row=db.prepare('SELECT value FROM entries WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;};
 const write=(key,value)=>db.prepare('INSERT OR REPLACE INTO entries (key,value) VALUES (?,?)').run(key,JSON.stringify(value));
 return {sql:{localFixture:true},
  failNext(stage){failure=stage;},
  async get(key){return read(key);},
  async put(key,value){if(failure==='put'){failure=null;throw new Error('fixture_put_failure');}write(key,value);},
  async setAlarm(value){if(failure==='alarm'){failure=null;throw new Error('fixture_alarm_failure');}write('_alarm',value);},
  async deleteAlarm(){if(failure==='alarm'){failure=null;throw new Error('fixture_alarm_failure');}db.prepare('DELETE FROM entries WHERE key=?').run('_alarm');},
  alarmAt(){return read('_alarm')??null;},
  transaction(callback){const operation=serial.then(async()=>{db.exec('BEGIN IMMEDIATE');try{const result=await callback();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}});serial=operation.catch(()=>{});return operation;},
  close(){db.close();},
 };
}
