import fs from 'node:fs/promises';
const root='/root/projects/code-ai',ops=root+'/ops/scheduler-startup-20261023';
const state=JSON.parse(await fs.readFile(root+'/.code-ai/queue/state.json','utf8'));
const files={
 '659e7a15-e94d-4e08-be54-dc9767bd4709':'/home/developer/.codex/sessions/2026/10/19/rollout-2026-10-19T18-55-00-01a15516-80d3-7641-bdcf-1f0895b49253.jsonl',
 'ab118022-d2d3-47ad-bfc0-ae2638e9de20':'/home/developer/.codex/sessions/2026/10/21/rollout-2026-10-21T04-30-03-01a15c4b-549b-7570-97f4-0ec2243f1ce9.jsonl'};
const jobs=[];
for(const[id,file]of Object.entries(files)){
 const item=state.items.find(i=>i.id===id),rows=(await fs.readFile(file,'utf8')).trim().split('\n').map(v=>JSON.parse(v));
 const turn=rows.find(r=>r.type==='event_msg'&&r.payload?.type==='task_complete'&&r.payload.turn_id===item.nativeSubmission?.turnId);
 jobs.push({id,sessionId:item.sessionId,status:item.status,promptPreview:item.promptPreview,reportedLastRunAt:item.lastRunAt,
  actualNativeCompletionAt:turn?.timestamp,retainedTurnId:item.nativeSubmission?.turnId,nextScheduledAt:item.scheduledAt,source:file});
}
await fs.writeFile(ops+'/diagnosis.json',JSON.stringify({at:new Date().toISOString(),jobs,
 cause:'Recurring schedule reused a prior completed native input identity and reconciled its historical result as a new run.',
 startup:'All-host synchronous health refresh blocks selected profile loading; measured approximately 22 seconds on the critical path.',
 recoveryPolicy:'Disabled jobs remain disabled. No destructive maintenance catch-up or real scheduled prompt is executed as a test.'},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(jobs.map(j=>({id:j.id,status:j.status,reported:j.reportedLastRunAt,actual:j.actualNativeCompletionAt}))));
