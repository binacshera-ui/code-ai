/** The original immutable build intent is resumed, never recaptured/re-keyed.
 * Any terminal failure stops expansion; it is not an invitation to redeploy. */
export async function resumeRelease({health,build,stage,deploy,schedule,save,prior={}}) {
 if(prior.phase==='complete')return{complete:true};
 if(prior.phase==='failed'||prior.phase==='activating')throw Error('manual_reconciliation_required');
 const h=await health();
 if(h.stopping||h.maintenance?.requested||h.scheduler?.intakeOpen!==true){await save('waiting-for-build-service');return{waiting:true};}
 await save('building');await build();
 await save('staging');await stage();
 await save('activating');await deploy();
 await save('scheduling-idle-owner-upgrades');await schedule();
 await save('complete');return{complete:true};
}
