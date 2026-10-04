const KEY = 'privacy-state-v1';
export const emptyState = () => ({version:1,epoch:null,retired:false,challenges:{},challengeWindow:{startedAt:0,count:0},receipt:null,mappingPurgeAt:null,leaseSequence:0,alarmAt:null});
/** SQLite-backed Durable Object storage. Every state mutation and alarm change
 * uses the SAME explicit storage transaction; no external I/O runs in it. */
export function createDurableStore(storage) {
  if (!storage?.sql || typeof storage.transaction !== 'function' || typeof storage.setAlarm !== 'function' || typeof storage.deleteAlarm !== 'function') throw new Error('sqlite_storage_required');
  return {
    async read(){return structuredClone((await storage.get(KEY))??emptyState());},
    async transaction(update){
      return storage.transaction(async()=>{
        const state=structuredClone((await storage.get(KEY))??emptyState());
        if(state.version!==1)throw new Error('unsupported_storage_version');
        const result=update(state);
        if(result && typeof result.then==='function')throw new Error('async_update_not_allowed');
        await storage.put(KEY,state);
        if(state.alarmAt===null)await storage.deleteAlarm();else await storage.setAlarm(state.alarmAt);
        return structuredClone(result);
      });
    },
  };
}
