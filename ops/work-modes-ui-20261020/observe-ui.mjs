import assert from'node:assert/strict';import{createHash}from'node:crypto';
/** A graceful NGINX reload is asynchronous. Only the exact accepted old shell
 * may be retried during handoff; unknown content and genuine errors fail. */
export async function observeUi(url,expected,predecessor,{fetch:request=globalThis.fetch,timeoutMs=10000,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
 const deadline=now()+timeoutMs;let attempts=0;
 for(;;){const response=await request(url,{headers:{'cache-control':'no-cache',connection:'close'},signal:AbortSignal.timeout(10000)});attempts++;
  assert.equal(response.status,200,url);const digest=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if(digest===expected)return{response,attempts};
  assert.equal(digest,predecessor,'Unknown shell content during frontend handoff');
  assert.ok(now()<deadline,'New frontend was not observed before the deadline');await pause(200);
 }
}
