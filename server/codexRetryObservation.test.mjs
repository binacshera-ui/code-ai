import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseCodexRetryDiagnostic,readCodexRetryObservation} from './codexRetryObservation.mjs';

const now=Date.now();
const body='stream disconnected - retrying sampling request (5/5 in 599.999s)... turn_id=turn-one retries=5 max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests';
const row={ts:Math.floor(now/1000),level:'WARN',target:'codex_core::responses_retry',body};
test('only pinned CLI 429 diagnostics for the exact live turn can signal retry',()=>{
  assert.deepEqual(parseCodexRetryDiagnostic(row,'turn-one',now),{turnId:'turn-one',kind:'rate_limit',observedAt:new Date(row.ts*1000).toISOString()});
  assert.ok(parseCodexRetryDiagnostic({...row,body:'task{turn.id=turn-one}: '+body},'turn-one',now));
  for(const extra of [{target:'assistant'},{level:'INFO'},{body:body.replace('429','503')},{body:body+' PRIVATE'},{ts:row.ts-601},{ts:row.ts+10}])
    assert.equal(parseCodexRetryDiagnostic({...row,...extra},'turn-one',now),null);
  assert.equal(parseCodexRetryDiagnostic(row,'turn-two',now),null);
});
test('profile-local indexed recovery ignores old warnings once output resumed and fails closed without a database',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cai-observe-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal(await readCodexRetryObservation(root,'thread-one','turn-one'),null);
  const db=new DatabaseSync(path.join(root,'logs_2.sqlite'));
  try {
    db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,level TEXT,target TEXT,feedback_log_body TEXT,thread_id TEXT); CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id,ts DESC,ts_nanos DESC,id DESC)');
    const insert=db.prepare('INSERT INTO logs(ts,ts_nanos,level,target,feedback_log_body,thread_id) VALUES(?,?,?,?,?,?)');
    insert.run(row.ts,0,'WARN',row.target,body,'thread-one');
    assert.ok(await readCodexRetryObservation(root,'thread-one','turn-one'));
    assert.equal(await readCodexRetryObservation(root,'thread-two','turn-one'),null);
    assert.equal(await readCodexRetryObservation(root,'thread-one','turn-two'),null);
    insert.run(row.ts,1,'INFO','codex_core::stream_events_utils','task{turn.id=turn-one}: Output item item_type="agentMessage"','thread-one');
    assert.equal(await readCodexRetryObservation(root,'thread-one','turn-one'),null);
    insert.run(row.ts,2,'WARN',row.target,body,'thread-one');
    assert.ok(await readCodexRetryObservation(root,'thread-one','turn-one'));
  } finally {db.close();}
});
