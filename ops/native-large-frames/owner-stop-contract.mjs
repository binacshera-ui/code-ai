/** Failed systemd stop is not a live owner; prove every prior generation dead.
 * A timeout, missing/unreadable proof or a surviving native writer fails closed.
 */
export function stopBudgetMs(text) {
  let total=0,matched='';
  for(const m of String(text).matchAll(/(\d+(?:\.\d+)?)\s*(min|ms|us|s)/g)) {
    total+=Number(m[1])*({min:60000,ms:1,us:0.001,s:1000}[m[2]]);matched+=m[0];
  }
  if(!matched||String(text).replace(/\s/g,'')!==matched.replace(/\s/g,'')||total<=0||total>105000)throw Error('owner_stop_budget_unknown');
  return total+15000;
}
export async function recordedGenerationDead(readFile,pid,generation) {
  if(!Number.isInteger(pid)||pid<2||typeof generation!=='string'||!generation)return false;
  try {
    const s=await readFile('/proc/'+pid+'/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/);
    if(f.length<20||!f[19]||!/^[A-Z]$/.test(f[0]))return false;
    return f[0]==='Z'||f[19]!==generation;
  } catch(e){return e.code==='ENOENT'||e.code==='ESRCH';}
}
export async function waitOwnerStopped({units,readUnit,readFile,now=Date.now,sleep,timeoutMs}) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('owner_stop_budget_unknown');
  const end=now()+timeoutMs;
  for(;;){
    let stopped=true;
    for(const u of units){
      const s=readUnit(u.name);
      if(!['inactive','failed'].includes(s.ActiveState)||String(s.MainPID)!=='0') {stopped=false;continue;}
      for(const p of u.prior)if(!await recordedGenerationDead(readFile,p.pid,p.generation))stopped=false;
    }
    if(stopped)return;
    if(now()>=end)throw Error('owner_stop_failed');
    await sleep(150);
  }
}
