/** Fail-closed native-owner replacement, not a work cancellation mechanism. */
export function isIdle({threads,queue,journal}) {
  return Array.isArray(threads)&&Array.isArray(queue)&&Array.isArray(journal)
    &&threads.every(t=>t.status==='idle'&&t.queued===0&&!t.activeGoal)
    &&queue.every(i=>['scheduled','draft','completed','failed','cancelled'].includes(i.status))
    &&journal.every(r=>r.phase==='released'&&r.turnComplete===true);
}
export async function idleTransaction({census,freeze,thaw,replace}) {
  if(!isIdle(await census()))return {applied:false,reason:'active-work'};
  const frozen=await freeze();
  try {
    // Frontend broker and all application processes are fenced before recheck.
    if(!isIdle(await census()))return {applied:false,reason:'admission-race'};
    return {applied:true,result:await replace(frozen)};
  }finally{await thaw(frozen);}
}
