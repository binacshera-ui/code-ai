/** Keep displayed text independent of a potentially enormous backing string.
 * UTF-16 preserves code units even when a display cutoff bisects a surrogate. */
export function detachSessionText(text) {
 return Buffer.from(text, 'utf16le').toString('utf16le');
}

/** One active and at most one fresh follow-up read per profile/window.
 * Callers arriving during a read share the follow-up, which captures its source
 * revision only after the preceding read finishes. Globally bound all reads,
 * including persisted JSON decoding, so changing files cannot multiply heaps. */
export function createSessionReadBudget({concurrency=2}={}) {
 if(!Number.isSafeInteger(concurrency)||concurrency<1)throw Error('Invalid session read concurrency');
 const entries=new Map(),queue=[];let active=0;
 function work(key,read){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{key,read,promise,resolve,reject,started:false}}
 function drain(){
  while(active<concurrency&&queue.length){
   const job=queue.shift();job.started=true;active++;
   void(async()=>{
    try{job.resolve(await job.read())}catch(e){job.reject(e)}finally{
     active--;const entry=entries.get(job.key);
     if(entry?.active===job){if(entry.pending){entry.active=entry.pending;entry.pending=null;queue.push(entry.active)}else entries.delete(job.key)}
     drain();
    }
   })();
  }
 }
 return{
  read(key,read){
   const entry=entries.get(key);
   if(entry){
    if(!entry.active.started){entry.active.read=read;return entry.active.promise}
    if(entry.pending){entry.pending.read=read;return entry.pending.promise}
    entry.pending=work(key,read);return entry.pending.promise;
   }
   const job=work(key,read);entries.set(key,{active:job,pending:null});queue.push(job);drain();return job.promise;
  },
  stats(){return{active,queued:queue.length,keys:entries.size}}
 };
}
