/** Native jobs/goals/terminals must finish naturally. Unknown custody blocks. */
export function isIdle(profiles,queue) {
  return Array.isArray(profiles)&&Array.isArray(queue)
    &&profiles.every(p=>Array.isArray(p.threads)&&Array.isArray(p.journal)
      &&p.threads.every(t=>t.status==='idle'&&t.queued===0&&!t.activeGoal&&t.backgroundTerminals===0)
      &&p.journal.every(r=>r.terminalProved===true))
    &&queue.every(i=>['draft','scheduled','completed','failed','cancelled'].includes(i.status)
      // Unsubmitted queued input is retained while admission is fenced. A
      // queued uncertain native input MUST be reconciled by the application first.
      ||i.status==='queued'&&!i.nativeSubmission);
}
export async function idleTransaction({census,freeze,thaw,replace}) {
  let current=await census();if(!isIdle(current.profiles,current.queue))return{applied:false,reason:'active-work'};
  const frozen=await freeze(current);
  try{current=await census();if(!isIdle(current.profiles,current.queue))return{applied:false,reason:'admission-race'};
    return{applied:true,result:await replace(frozen,current)};
  }finally{await thaw(frozen);}
}
