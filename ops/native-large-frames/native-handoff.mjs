/** Deployment-only bounded core handoff. Never signals the native owner.
 * The installed predecessor's graceful shutdown cancels accepted native work.
 * A stopped core cannot execute that handler; its manager then replaces only
 * the core. The successor reattaches durable IDs, never resends input.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export function eligibleNativeWork(items, profiles) {
  const live=items.filter(i=>['running','cancelling'].includes(i.status)
    ||i.status==='queued'&&i.nativeSubmission&&!['completed','cancelled'].includes(i.nativeSubmission.deliveryPhase));
  if(!live.length)return [];
  assert.ok(live.every(i=>i.status!=='cancelling'&&profiles.includes(i.profileId)
    &&i.sessionId&&i.nativeSubmission?.clientUserMessageId==='code-ai:'+(i.nativeRunId||i.id)
    &&['prepared','queued','running','detached'].includes(i.nativeSubmission.deliveryPhase)),
    'Active work is not proven detachable native custody');
  return live.map(i=>({id:i.id,sessionId:i.sessionId,clientId:i.nativeSubmission.clientUserMessageId,
    queuedId:i.nativeSubmission.queuedSubmissionId,turnId:i.nativeSubmission.turnId}));
}

export async function withNativeHandoff({pid,items,profiles,replace,signal=process.kill,identity=processIdentity}) {
  assert.ok(Number.isInteger(pid)&&pid>1);
  const preserved=eligibleNativeWork(items,profiles);
  if(!preserved.length)return {result:await replace(),preserved:[],suspended:false};
  const generation=await identity(pid);
  signal(pid,'SIGSTOP');
  try {return {result:await replace(),preserved,suspended:true};}
  finally {
    // Resume only the same original process if a pre-switch gate failed.
    // Never signal a successor or a PID reused by an unrelated process.
    try {if(await identity(pid)===generation)signal(pid,'SIGCONT');}catch{}
  }
}
async function processIdentity(pid) {
  const s=await readFile('/proc/'+pid+'/stat','utf8');
  return s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/)[19];
}
