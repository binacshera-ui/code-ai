/** Resolve the actual unit's one pinned plan, not a missing request field. */
export function selectOwnerPlanFile(execStart,ownerDirectory){
 if(typeof execStart!=='string'||typeof ownerDirectory!=='string')throw Error('owner_plan_unavailable');
 const matches=execStart.match(/\/[^;\s]+\/profile-[a-f0-9-]{36}\.json/g)||[];
 if(matches.length!==1||!matches[0].startsWith(ownerDirectory+'/profile-'))throw Error('owner_plan_unavailable');
 return matches[0];
}
