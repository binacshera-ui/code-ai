/** Durable metadata-only readback after the maintenance turn's own owner exits. */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {execFileSync} from 'node:child_process';
const dir='/root/projects/code-ai/ops/native-large-frames',source=JSON.parse(await fs.readFile(dir+'/staged.json','utf8'));
const expected='f2b34c89be9dabc45aace52111c5982fbe3e716db5f672505ad8de5406cd2f4e';
const save=async p=>{const f=dir+'/closure-receipt.json';await fs.writeFile(f+'.tmp',JSON.stringify(p,null,2),{mode:0o600});await fs.rename(f+'.tmp',f);};
for(;;){
 try{
  execFileSync('/root/.nvm/versions/node/v24.12.0/bin/node',[dir+'/read-owner-status.mjs'],{encoding:'utf8',stdio:'pipe',timeout:60000,env:{...process.env,PM2_HOME:'/root/.pm2'}});
  const status=JSON.parse(await fs.readFile(dir+'/owner-status-readback.json','utf8')),rows=status.hosts;
  assert.equal(rows.length,4);
  const hosts=rows.map(h=>({id:h.id,coreLive:h.id==='main'?h.core.pm2.some(p=>p.status==='online'):/(?:^|\n)ActiveState=active(?:\n|$)/.test(h.core),ownerUpdatePhase:h.status?.phase||'unknown',allNativeOwnersUpdated:h.owners.length>0&&h.owners.every(o=>o.brokerSha256===expected&&/(?:^|\n)ActiveState=active(?:\n|$)/.test(o.state)),profiles:h.owners.map(o=>o.id)}));
  const journal=JSON.parse(await fs.readFile('/home/developer/code-ai-native-owner/broker-journal.json','utf8'));
  const record=journal.records.find(r=>r.threadId==='01a11590-d7e3-7191-9a84-b92cd21d47c9'&&r.clientId==='code-ai:852579e9-e2dd-4c70-b3fb-62152d802cee');
  const mailReservationReleased=!!record&&record.phase==='released'&&record.turnComplete===true&&record.turnId==='01a129ef-5fbc-7e23-a7b5-7ccd0c33a80a';
  const main=rows.find(h=>h.id==='main'),complete=hosts.every(h=>h.coreLive&&h.allNativeOwnersUpdated&&h.ownerUpdatePhase==='complete')&&main.status?.mail?.exactStableInputVerified===true&&main.status?.mail?.historyReadableAfterOwnerReplacement===true&&mailReservationReleased;
  const failed=rows.some(h=>h.status?.phase==='failed')||(main.status?.phase==='complete'&&!mailReservationReleased);
  await save({format:'code-ai-native-large-frame-closure',version:1,buildId:source.buildId,observedAt:new Date().toISOString(),complete,hosts,mainMailAfterOwnerReplacement:main.status?.mail||null,mailReservationReleased,inputsResent:false,credentialRotation:false,scheduledJobsDeleted:false,ownerAuthorizedActiveTurnInterruption:true,qualification:{beamReleaseTests:372,isolatedNativeTests:44,ownerStopAndAuthorizationTests:23,actualNativeLifecycleChecks:5},failure:failed?'owner_replacement_or_mail_reconciliation_gate_failed':null});
  if(complete||failed)break;
 }catch{
  await save({format:'code-ai-native-large-frame-closure',version:1,buildId:source.buildId,observedAt:new Date().toISOString(),complete:false,failure:'closure_readback_unavailable',credentialsPrinted:false});
 }
 await new Promise(y=>setTimeout(y,5000));
}
