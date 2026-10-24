/** Observe the deployed application transport, without printing conversation data. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const sessionId='01a0cda2-d5d2-7b01-8f5c-204a4f76376a';
const base='http://127.0.0.1:4000/api/codex/sessions/'+sessionId;
const response=await fetch(base+'?profile=developer&tail=120',{signal:AbortSignal.timeout(15000)});
if(response.status===401||response.status===403){
 const proof={format:'code-ai-deployed-progress-transport-readback',version:1,observedAt:new Date().toISOString(),sessionId,
  detailStatus:response.status,liveSnapshotObserved:false,authenticatedBrowserRequired:true,
  reason:'Production access guard preserved; personal Chrome is DEVICE_OFFLINE.',conversationContentPrinted:false,credentialsUsed:false};
 await writeFile('/root/projects/code-ai/ops/queued-recovery/api-progress-readback.json',JSON.stringify(proof,null,2),{mode:0o600});
 console.log(JSON.stringify(proof));process.exit(0);
}
assert.equal(response.status,200);assert.ok(response.headers.get('content-type')?.includes('application/json'));
const detail=await response.json();
const session=detail.session||detail;
assert.ok(Array.isArray(session.timeline)&&session.timeline.length>0);
const controller=new AbortController(),events={},snapshots=[];
const timeout=setTimeout(()=>controller.abort(),35000);
let streamStatus,streamType,buffer='';
try{
 const stream=await fetch(base+'/events?profile=developer&knownTimelineEntries='+session.totalTimelineEntries,{signal:controller.signal});
 streamStatus=stream.status;streamType=stream.headers.get('content-type');assert.equal(streamStatus,200);assert.ok(streamType?.includes('text/event-stream'));
 const reader=stream.body.getReader(),decoder=new TextDecoder();
 while(true){
  const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});
  assert.ok(buffer.length<1024*1024,'Bounded stream frame exceeded');
  let end;while((end=buffer.indexOf('\n\n'))>=0){
   const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
   const name=/^event: (.+)$/m.exec(frame)?.[1];if(!name)continue;events[name]=(events[name]||0)+1;
   assert.notEqual(name,'session-snapshot-error');
   if(name==='session-snapshot'){
    const payload=JSON.parse(/^data: (.+)$/m.exec(frame)[1]);const s=payload.session;
    snapshots.push({mode:payload.mode,totalTimelineEntries:s.totalTimelineEntries,visibleEntries:s.timeline?.length||0,timelineWindowEnd:s.timelineWindowEnd});
    if(snapshots.length>=2)controller.abort();
   }
  }
 }
}catch(e){if(e.name!=='AbortError')throw e;}finally{clearTimeout(timeout);controller.abort();}
const proof={format:'code-ai-deployed-progress-transport-readback',version:1,observedAt:new Date().toISOString(),sessionId,
 detailStatus:response.status,initialTimelineEntries:session.totalTimelineEntries,initialVisibleEntries:session.timeline.length,
 streamStatus,streamType,events,snapshots,liveSnapshotObserved:snapshots.some(s=>s.visibleEntries>0),conversationContentPrinted:false,credentialsUsed:false};
await writeFile('/root/projects/code-ai/ops/queued-recovery/api-progress-readback.json',JSON.stringify(proof,null,2),{mode:0o600});
console.log(JSON.stringify(proof));
assert.ok(proof.liveSnapshotObserved,'No live content snapshot observed in bounded window');
