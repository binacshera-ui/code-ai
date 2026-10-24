/** Explicit disruptive authorization is separate from normal idle replacement. */
export function maintenanceRetirementSafe({phase,coreState,owners,ownerJobs}) {
 return ['waiting-for-idle','waiting-for-prior-worker'].includes(phase)
   &&['S','R','I'].includes(coreState)&&Array.isArray(owners)&&owners.length>0
   &&owners.every(p=>p.unitActive==='active'&&['S','R','I'].includes(p.runnerState)&&['S','R','I'].includes(p.nativeState))
   &&Array.isArray(ownerJobs)&&ownerJobs.length===0;
}
export async function authorizedReplacement({authorized,census,freeze,thaw,replace,selfIdle}) {
 if(authorized!==true)throw Error('explicit_interruption_authority_required');
 let current=await census();if(!await selfIdle())return{applied:false,reason:'maintenance-turn-active'};
 const fence=await freeze(current);
 try{
  current=await census();if(!await selfIdle())return{applied:false,reason:'maintenance-turn-admission-race'};
  return{applied:true,result:await replace(fence,current)};
 }finally{await thaw(fence);}
}
