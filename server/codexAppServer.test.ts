import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexAppServerTurn, CodexAppServerCancelledError, CodexAppServerDetachedError,
  CodexSharedOwnerSettingsMismatchError, isCodexSharedOwnerSettingsMismatchError, CodexSharedAdmissionRejectedError,
  CodexAppServerTurnFailedError,
  isCodexSharedSubmissionTerminal,
  type CodexSharedSubmission, type CodexSharedOwnerSettings, type CodexAppServerRunOptions } from './codexAppServer.js';
import { CodexUserInputRegistry } from './codexUserInput.js';

/** Deterministic stdio fixture, not a provider/model turn. Never reads credentials. */
function fixture(mode: string): string {
  return `
    const readline = require('node:readline');
    const mode = ${JSON.stringify(mode)};
    const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
    const rl = readline.createInterface({input:process.stdin});
    if(mode==='graceful') rl.on('close',()=>setTimeout(()=>process.exit(0),100));
    let initialized = false, acknowledged = false, approvals = 0;
    const nativeThread = mode.includes('child') ? 'child-thread' : 'parent-thread';
    const question = {id:'choice', header:'Target', question:'Where?', isOther:true, isSecret:false, options:[{label:'Local',description:'Here'}]};
    function userInput(){send({id:77,method:'item/tool/requestUserInput',params:{threadId:nativeThread,turnId:mode.startsWith('shared-child')||mode.startsWith('shared-recover-child')?'child-turn':'turn-one',itemId:'input-one',questions:[question],isBlocking:mode !== 'async',autoResolutionMs:1}});}
    function finishOwn(){send({method:'item/completed',params:{threadId:'parent-thread',turnId:'turn-one',item:{type:'agentMessage',phase:'final_answer',text:'Done'}}});send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'completed'}}});}
    rl.on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize'){
        if(mode==='shared-recover-init-detached'){process.exit(0);return;}
        if(m.params.capabilities?.experimentalApi!==true) process.exit(14);
        initialized=true;send({id:m.id,result:{userAgent:'synthetic/0.160.1',
          ...(mode.startsWith('shared-managed')?{codeAiSharedOwner:{version:1,turnSettings:true}}:{})}});
      } else if(m.method==='initialized') { acknowledged=true; }
      else if(m.method==='thread/start'||m.method==='thread/resume'){
        if(mode==='rpc-diagnostic') {
          send({id:m.id,error:{code:-32603,message:'PRIVATE_ERROR_MUST_NOT_ESCAPE token=private-test-marker',data:{
            codeAiDiagnostic:{version:1,operation:'thread/resume',reason:'native-read-timeout',nativeCode:null,elapsedMs:120000,secret:'private-test-marker'}}}});return;
        }
        if(mode.startsWith('shared-recover-child')&&m.params.threadId==='child-thread') {
          send({id:m.id,result:{thread:{id:'child-thread'}}}); userInput(); return;
        }
        if(!initialized||!acknowledged||m.params.cwd!==process.cwd()) process.exit(15);
        if(mode==='shared-managed' && (m.params.model!=='synthetic-requested-model'
          ||m.params.config?.model_reasoning_effort!=='xhigh'
          ||'approvalPolicy' in m.params||'sandbox' in m.params||'permissions' in m.params))process.exit(36);
        if(mode==='shared-managed-resume' && ('model' in m.params||'config' in m.params
          ||'approvalPolicy' in m.params||'sandbox' in m.params||'permissions' in m.params))process.exit(37);

        if((mode==='resume'||mode==='shared-managed-resume'||mode.includes('recover')) && (m.method!=='thread/resume'||m.params.threadId!=='parent-thread')) process.exit(16);
        if(mode!=='resume'&&mode!=='shared-managed-resume'&&!mode.includes('recover') && (m.method!=='thread/start'||m.params.ephemeral!==false)) process.exit(17);
        send({id:m.id,result:{thread:{id:'parent-thread',path:'/synthetic/session.jsonl',status:{type:mode==='shared-busy'?'active':'idle'}},
          ...(mode==='shared-settings-missing'?{}:{model:'synthetic-model',modelProvider:'synthetic-provider',serviceTier:null,
            cwd:process.cwd(),approvalPolicy:'never',sandbox:{type:'workspaceWrite',writableRoots:['/synthetic/workspace'],
              networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true},reasoningEffort:'high'})}});
        if(mode==='shared-recover-active') {
          send({method:'serverRequest/resolved',params:{threadId:'foreign-thread',requestId:77}});
          send({method:'serverRequest/resolved',params:{threadId:'parent-thread',requestId:'77'}});
          send({id:88,method:'item/tool/requestUserInput',params:{threadId:'parent-thread',turnId:'desktop-turn',itemId:'foreign-replay',questions:[question]}});
          userInput();
        }
        if(mode.endsWith('resolved-before-proof')) {
          send({id:88,method:'item/tool/requestUserInput',params:{threadId:'parent-thread',turnId:'desktop-turn',itemId:'foreign-replay',questions:[question]}});
          userInput();
          // A competing GUI client resolves the replayed native question while
          // Code AI is still waiting for its stable-client-ID history proof.
          send({method:'serverRequest/resolved',params:{threadId:nativeThread,requestId:77}});
          send({method:'serverRequest/resolved',params:{threadId:'foreign-thread',requestId:77}});
        }
        if(mode==='shared-recover-tombstone-overflow') for(let index=0;index<65;index++) {
          send({method:'serverRequest/resolved',params:{threadId:'pending-child-'+index,requestId:77}});
        }
      } else if(m.method==='thread/read'){
        if(mode.startsWith('shared-recover-child')&&m.params.threadId==='child-thread') {
          send({id:m.id,result:{thread:{turns:[]}}});
          if(mode.endsWith('resolved-before-proof')) finishOwn();
        } else if(mode==='shared-recover-completed'||mode==='shared-recover-failed-usage'||mode==='shared-cancel-read-failed'||mode==='shared-recover-active'||mode.startsWith('shared-recover-child')||mode==='shared-recover-resolved-before-proof') {
          send({id:m.id,result:{thread:{turns:[{id:'turn-one',status:mode==='shared-recover-completed'?'completed':mode==='shared-recover-failed-usage'||mode==='shared-cancel-read-failed'?'failed':'inProgress',
            ...(mode==='shared-recover-failed-usage'||mode==='shared-cancel-read-failed'?{error:{message:'PRIVATE_ERROR',codexErrorInfo:'usageLimitExceeded'}}:{}),items:[
            {type:'userMessage',clientId:'code-ai:recovered',content:[]},
            ...(mode.startsWith('shared-recover-child')?[{type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'parent-thread',receiverThreadIds:['child-thread']}]:[]),
            {type:'agentMessage',phase:'final_answer',text:'Recovered final'}]}]}}});
        } else send({id:m.id,result:{thread:{turns:[]}}});
      } else if(m.method==='synthetic/finish') { finishOwn(); }
      else if(m.method==='thread/queue/list'){
        if(mode==='shared-recover-pending') {
          send({id:m.id,result:{data:[{id:'queued-one',clientUserMessageId:'code-ai:recovered'}],nextCursor:null}});
          setTimeout(()=>{
            send({method:'item/started',params:{threadId:'parent-thread',turnId:'turn-one',item:{type:'userMessage',clientId:'code-ai:recovered',content:[]}}});
            userInput();
          },20);
        } else send({id:m.id,result:{data:[],nextCursor:null}});
      } else if(m.method==='turn/start'||m.method==='thread/queue/add'){
        if(mode==='shared-managed-busy'||mode==='shared-managed-uncertain') {
          send({id:m.id,error:{code:-32001,message:'PRIVATE_ERROR_MUST_NOT_ESCAPE',data:{
            codeAiAdmission:mode==='shared-managed-busy'?'notAccepted':'uncertain',reason:'foreign-queue-pending'}}});return;
        }
        if(mode==='shared-managed' && JSON.stringify(m.params.codeAiTurnSettings)!==JSON.stringify({
          model:'synthetic-requested-model',effort:'xhigh',cwd:process.cwd(),approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}
        }))process.exit(31);
        if(mode==='shared-settings-no-enqueue'||mode==='shared-settings-missing') process.exit(30);
        if(mode.includes('recover')) process.exit(29);
        if(mode.startsWith('shared')&&m.method==='turn/start') process.exit(25);
        if(mode.startsWith('shared')) {
          send({id:m.id,result:{queuedSubmission:{id:'queued-one',clientUserMessageId:m.params.clientUserMessageId}}});
          if(mode==='shared-detached'){process.exit(0);return;}
          if(mode==='shared-cancel-pending'||mode==='shared-cancel-read-failed') return;
          send({method:'turn/started',params:{threadId:'parent-thread',turn:{id:'desktop-turn',status:'inProgress'}}});
          send({id:88,method:'item/tool/requestUserInput',params:{threadId:'parent-thread',turnId:'desktop-turn',itemId:'desktop-input',questions:[question]}});
          send({method:'item/completed',params:{threadId:'parent-thread',turnId:'desktop-turn',item:{type:'agentMessage',phase:'final_answer',text:'Do not adopt desktop output'}}});
          send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'desktop-turn',status:'completed'}}});
          send({method:'turn/started',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'inProgress'}}});
          send({method:'item/started',params:{threadId:'parent-thread',turnId:'turn-one',item:{type:'userMessage',clientId:m.params.clientUserMessageId,content:[]}}});
          if(mode==='shared-child'||mode==='shared-child-detach') send({method:'item/started',params:{threadId:'parent-thread',turnId:'turn-one',item:{type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'parent-thread',receiverThreadIds:['child-thread']}}});
          if(mode==='shared-child-race') {
            userInput();
            setTimeout(()=>send({method:'item/completed',params:{threadId:'parent-thread',turnId:'turn-one',item:{type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'parent-thread',receiverThreadIds:['child-thread']}}}),20);
            return;
          }
        }
        if(m.params.threadId!=='parent-thread'||m.params.input[0].text!=='Prompt'||!Array.isArray(m.params.input[0].text_elements)) process.exit(18);
        if(m.params.input[1]?.type!=='localImage'||m.params.input[1]?.path!=='/synthetic/image.png') process.exit(19);
        if(!mode.startsWith('shared')){
          send({id:m.id,result:{turn:{id:'turn-one',status:'inProgress'}}});
          send({method:'turn/started',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'inProgress'}}});
        }
        if(mode==='oversize'){process.stdout.write('x'.repeat(2000));return;}
        if(mode==='malformed'){process.stdout.write('not json\\n');return;}
        if(mode==='failed'){send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'failed',error:{message:'private-error'}}}});return;}
        if(mode==='failed-code'){send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'failed',error:{message:'private-error',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}},additionalDetails:'private-detail'}}}});return;}
        if(mode==='failed-usage'||mode==='shared-failed-usage'){send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'failed',error:{message:'This model is unavailable, try another model. PRIVATE_ERROR',codexErrorInfo:'usageLimitExceeded'}}}});return;}
        if(mode==='completed-quoted-error') {send({method:'item/completed',params:{threadId:'parent-thread',turnId:'turn-one',item:{type:'agentMessage',phase:'final_answer',text:'The quoted message says: this model is unavailable, try another model.'}}});send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'completed'}}});return;}
        if(mode==='retry-error'||mode==='nonretry-error-then-completed') send({method:'error',params:{threadId:'parent-thread',turnId:'turn-one',willRetry:mode==='retry-error',error:{message:'PRIVATE_RETRY',codexErrorInfo:'rateLimitExceeded'}}});
        if(mode.includes('progress-guard')) {
          for(let i=0;i<3;i++)send({method:'item/completed',params:{threadId:'parent-thread',turnId:mode.endsWith('foreign')?'desktop-turn':'turn-one',item:{id:'failed-'+i,type:'commandExecution',status:'completed',command:'synthetic failing command PRIVATE_COMMAND',aggregatedOutput:'PRIVATE_FAILURE_OUTPUT',exitCode:1}}});
          if(mode.endsWith('disabled')||mode.endsWith('denied')||mode.endsWith('foreign'))userInput();
          return;
        }
        if(mode==='closed'){process.exit(0);return;}
        if(mode==='denials'){
          send({id:70,method:'item/commandExecution/requestApproval',params:{threadId:'parent-thread'}});
          send({id:71,method:'item/fileChange/requestApproval',params:{threadId:'parent-thread'}});
          send({id:72,method:'item/permissions/requestApproval',params:{threadId:'parent-thread'}});
          send({id:73,method:'mcpServer/elicitation/request',params:{threadId:'parent-thread'}});
          send({id:74,method:'unknown/request',params:{secret:'never-expose'}});
          return;
        }
        userInput();
        if(mode==='shared-detach-active'||mode==='shared-child-detach') setTimeout(()=>process.exit(0),50);
      } else if(m.method==='turn/steer'){
        if(!mode.includes('progress-guard')||m.params.threadId!=='parent-thread'||m.params.expectedTurnId!=='turn-one'
          ||m.params.input.length!==1||m.params.input[0].type!=='text'||m.params.input[0].text.includes('PRIVATE')) process.exit(40);
        if(mode.endsWith('timeout')) {setTimeout(userInput,350);return;}
        if(mode.endsWith('rejected')) send({id:m.id,error:{code:-32602,message:'PRIVATE_STEER_REJECTED'}});
        else send({id:m.id,result:{turnId:'turn-one'}});
        // Further failures cannot cause another steer in the same native turn.
        for(let i=3;i<7;i++)send({method:'item/completed',params:{threadId:'parent-thread',turnId:'turn-one',item:{id:'failed-'+i,type:'commandExecution',status:'completed',command:'synthetic failing command PRIVATE_COMMAND',aggregatedOutput:'PRIVATE_FAILURE_OUTPUT',exitCode:1}}});
        userInput();
      } else if(m.method==='thread/queue/delete'){
        if(m.params.queuedSubmissionId!=='queued-one') process.exit(27);
        send({id:m.id,result:{deleted:mode!=='shared-cancel-read-failed'}});
      } else if(m.method==='turn/interrupt') {
        if(m.params.turnId!=='turn-one') process.exit(28);
        send({id:m.id,result:{}});
        if(mode==='shared-cancel-unresolved') return;
        send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'interrupted'}}});
      } else if(m.id===88) { process.exit(26); }
      else if(m.id>=70&&m.id<=74){
        if(m.id===70||m.id===71){if(m.result?.decision!=='decline') process.exit(20);}
        if(m.id===72){if(JSON.stringify(m.result)!==JSON.stringify({permissions:{},scope:'turn'})) process.exit(21);}
        if(m.id===73&&m.result?.action!=='decline') process.exit(22);
        if(m.id===74&&m.error?.code!==-32601) process.exit(23);
        approvals++;if(approvals===5) userInput();
      } else if(m.id===77){
        if(JSON.stringify(m.result)!==JSON.stringify({answers:{choice:{answers:['Custom target']}}})) process.exit(24);
        send({method:'serverRequest/resolved',params:{threadId:nativeThread,requestId:77}});
        send({method:'item/completed',params:{threadId:'parent-thread',turnId:'turn-one',item:{id:'commentary',type:'agentMessage',phase:'commentary',text:'Working'}}});
        send({method:'item/completed',params:{threadId:'other-thread',item:{id:'other-final',type:'agentMessage',phase:'final_answer',text:'Wrong child result'}}});
        send({method:'item/completed',params:{threadId:'parent-thread',turnId:'turn-one',item:{id:'final',type:'agentMessage',phase:'final_answer',text:'Done'}}});
        send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'completed'}}});
      }
    });
  `;
}

function options(mode: string, registry = new CodexUserInputRegistry()): CodexAppServerRunOptions {
  return {
    bin: process.execPath, args: ['-e', fixture(mode), 'app-server'], env: {}, cwd: process.cwd(),
    profileId: 'codex-test', runId: `run-${mode}`, prompt: 'Prompt', imagePaths: ['/synthetic/image.png'],
    registry, requestTimeoutMs: 2_000,
    ...(mode === 'resume' ? { sessionId: 'parent-thread' } : {}),
  };
}

test('safe RPC reason reaches the queue error without native messages or peer extra fields', async () => {
  await assert.rejects(runCodexAppServerTurn(options('rpc-diagnostic')), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /-32603.*thread\/resume: native-read-timeout/);
    assert.equal(message.includes('PRIVATE_ERROR'), false);
    assert.equal(message.includes('private-test-marker'), false);
    return true;
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for synthetic native request');
}

for (const mode of ['blocking', 'async', 'child', 'resume', 'denials']) {
  test(`native ${mode} request answers its original turn and preserves parent session ownership`, async () => {
    const registry = new CodexUserInputRegistry();
    let sessionCallbackFinished = false;
    const denied: string[] = [];
    const run = runCodexAppServerTurn({ ...options(mode, registry),
      onSessionStarted: async sessionId => {
        assert.equal(sessionId, 'parent-thread');
        await new Promise(resolve => setTimeout(resolve, 20));
        sessionCallbackFinished = true;
      },
      onApprovalDenied: method => denied.push(method),
    });
    await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
    assert.equal(sessionCallbackFinished, true);
    const request = registry.list('codex-test', 'parent-thread').requests[0];
    assert.equal(request.isBlocking, mode !== 'async');
    assert.equal(request.sessionId, 'parent-thread');
    await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: request.id,
      answers: { choice: { answers: ['Custom target'] } } });
    const result = await run;
    assert.deepEqual(result, { sessionId: 'parent-thread', lastMessage: 'Done', threadPath: '/synthetic/session.jsonl' });
    assert.equal(registry.list('codex-test', 'parent-thread').requests[0].status, 'answered');
    if (mode === 'denials') assert.deepEqual(denied.sort(), [
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
    ]);
  });
}

test('cancelled turn closes native pending input without an empty or synthetic answer', async () => {
  const registry = new CodexUserInputRegistry();
  const controller = new AbortController();
  const run = runCodexAppServerTurn({ ...options('cancel', registry), signal: controller.signal });
  const rejected = assert.rejects(run, CodexAppServerCancelledError);
  await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
  controller.abort();
  await rejected;
  const requests = registry.list('codex-test', 'parent-thread').requests;
  assert.equal(requests[0].status, 'cancelled');
  assert.equal(requests[0].answers, undefined);
});

for (const mode of ['oversize', 'malformed', 'failed', 'closed']) {
  test(`${mode} native transport/turn fails explicitly instead of hanging or claiming success`, async () => {
    const registry = new CodexUserInputRegistry();
    await assert.rejects(runCodexAppServerTurn({ ...options(mode, registry), ...(mode === 'oversize' ? { maxFrameBytes: 1024 } : {}) }),
      (error: unknown) => error instanceof Error && !error.message.includes('private-error'));
    assert.equal(registry.list('codex-test', 'parent-thread').pendingCount, 0);
  });
}

test('session persistence callback failure prevents turn/start and any model work', async () => {
  await assert.rejects(runCodexAppServerTurn({ ...options('blocking'),
    onSessionStarted: () => { throw new Error('Cannot persist session ownership'); },
  }), /Cannot persist session ownership/);
});

test('completed turns await graceful native EOF shutdown before reporting success', async () => {
  const registry = new CodexUserInputRegistry();
  const run = runCodexAppServerTurn(options('graceful', registry));
  await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
  const request = registry.list('codex-test', 'parent-thread').requests[0];
  const beforeAnswer = performance.now();
  await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: request.id,
    answers: { choice: { answers: ['Custom target'] } } });
  assert.equal((await run).lastMessage, 'Done');
  assert.ok(performance.now() - beforeAnswer >= 80, 'runner resolved before native process finished its EOF flush');
});

test('already aborted runs do not spawn a process', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(runCodexAppServerTurn({ ...options('blocking'), signal: controller.signal, onSpawn: () => { spawned = true; } }), CodexAppServerCancelledError);
  assert.equal(spawned, false);
});

test('spawn diagnostics expose safe OS codes without private executable paths', async () => {
  await assert.rejects(runCodexAppServerTurn({ ...options('blocking'), bin: '/__code_ai_qualification_missing__/codex' }),
    (error: unknown) => error instanceof Error && /ENOENT/.test(error.message) && !error.message.includes('__code_ai_qualification_missing__'));
});

test('native turn diagnostics expose only known category and HTTP status, never private details', async () => {
  await assert.rejects(runCodexAppServerTurn(options('failed-code')),
    (error: unknown) => error instanceof Error && /httpConnectionFailed; HTTP 503/.test(error.message)
      && !error.message.includes('private-error') && !error.message.includes('private-detail'));
});

test('native model limit is a typed failed terminal outcome, never a successful assistant answer', async () => {
  await assert.rejects(runCodexAppServerTurn(options('failed-usage')), (error: unknown) => {
    assert.ok(error instanceof CodexAppServerTurnFailedError);
    assert.equal(error.failure.kind, 'usage_limit');
    assert.equal(error.failure.code, 'usageLimitExceeded');
    assert.equal(error.message.includes('PRIVATE'), false);
    return true;
  });
});

for (const mode of ['retry-error', 'nonretry-error-then-completed']) {
  test(`${mode} notification cannot replace the native terminal outcome`, async () => {
    const registry = new CodexUserInputRegistry();
    const notifications: string[] = [];
    const run = runCodexAppServerTurn({ ...options(mode, registry), onNotification: method => notifications.push(method) });
    await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
    const request = registry.list('codex-test', 'parent-thread').requests[0];
    await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: request.id,
      answers: { choice: { answers: ['Custom target'] } } });
    assert.equal((await run).lastMessage, 'Done');
    assert.ok(notifications.includes('error'));
  });
}

test('a successful assistant quoting a model-unavailable error remains successful', async () => {
  const result = await runCodexAppServerTurn(options('completed-quoted-error'));
  assert.match(result.lastMessage, /quoted message/);
});

for (const mode of ['shared-failed-usage', 'shared-recover-failed-usage', 'shared-cancel-read-failed']) {
  test(`${mode} preserves typed failure and terminal custody without a blind retry`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-native-limit-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const phases: string[] = [];
    const recovered = mode.includes('recover');
    const run = runCodexAppServerTurn({ ...options(mode), ...(recovered ? { sessionId: 'parent-thread' } : {}),
      signal: controller.signal,
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', clientUserMessageId: 'code-ai:recovered',
        ...(recovered ? { resumeSubmission: { clientUserMessageId: 'code-ai:recovered', queuedSubmissionId: 'queued-one', turnId: 'turn-one', deliveryPhase: 'detached' as const } } : {}),
        onSubmissionChanged: state => {
          phases.push(state.deliveryPhase);
          if (mode === 'shared-cancel-read-failed' && state.deliveryPhase === 'queued') controller.abort();
        } },
    });
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof CodexAppServerTurnFailedError);
      assert.equal(error.failure.kind, 'usage_limit');
      return true;
    });
    assert.equal(phases.at(-1), 'completed', 'completed is terminal delivery custody, not turn success');
    assert.equal(phases.includes('detached'), false);
  });
}

for (const mode of ['progress-guard', 'shared-progress-guard', 'progress-guard-rejected', 'progress-guard-timeout']) {
  test(`${mode} uses one durably claimed expected-turn steer and cannot abort healthy work`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-progress-guard-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new CodexUserInputRegistry();
    const claims: unknown[] = [];
    const warnings: { intervention: string }[] = [];
    const run = runCodexAppServerTurn({ ...options(mode, registry),
      ...(mode.endsWith('timeout') ? { requestTimeoutMs: 150 } : {}),
      ...(mode.startsWith('shared') ? { sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed' } } : {}),
      progressGuardEnabled: true,
      onProgressGuardClaim: async claim => {
        assert.equal(claim.turnId, 'turn-one');
        assert.equal(claim.kind, 'repeated_failure');
        assert.equal(claim.count, 3);
        assert.equal(JSON.stringify(claim).includes('PRIVATE'), false);
        claims.push(claim);
        return true;
      },
      onProgressGuardWarning: async warning => { warnings.push(warning); },
    });
    await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
    const question = registry.list('codex-test', 'parent-thread').requests[0];
    await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: question.id,
      answers: { choice: { answers: ['Custom target'] } } });
    assert.equal((await run).lastMessage, 'Done');
    assert.equal(claims.length, 1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].intervention, mode.endsWith('rejected') || mode.endsWith('timeout') ? 'unavailable' : 'applied');
  });
}

for (const mode of ['progress-guard-disabled', 'progress-guard-denied', 'shared-progress-guard-foreign']) {
  test(`${mode} cannot steer without opt-in, durable claim and exact native turn ownership`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-progress-guard-restriction-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new CodexUserInputRegistry();
    let claims = 0;
    let warnings = 0;
    const run = runCodexAppServerTurn({ ...options(mode, registry),
      ...(mode.startsWith('shared') ? { sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed' } } : {}),
      progressGuardEnabled: !mode.endsWith('disabled'),
      onProgressGuardClaim: async () => { claims++; return false; },
      onProgressGuardWarning: async () => { warnings++; },
    });
    await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
    const question = registry.list('codex-test', 'parent-thread').requests[0];
    await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: question.id,
      answers: { choice: { answers: ['Custom target'] } } });
    assert.equal((await run).lastMessage, 'Done');
    assert.equal(claims, mode.endsWith('denied') ? 1 : 0);
    assert.equal(warnings, 0);
  });
}

for (const mode of ['shared', 'shared-busy', 'shared-child', 'shared-child-race']) {
  test(`${mode} does not steal native desktop ownership or its questions`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-runner-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new CodexUserInputRegistry();
    const run = runCodexAppServerTurn({ ...options(mode, registry),
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-an-installed-socket' } });
    await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
    const requests = registry.list('codex-test', 'parent-thread').requests;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].turnId, mode.startsWith('shared-child') ? 'child-turn' : 'turn-one');
    await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: requests[0].id,
      answers: { choice: { answers: ['Custom target'] } } });
    assert.equal((await run).lastMessage, 'Done');
  });
}

test('shared queue acceptance survives a client disconnect and exposes durable custody, not a retryable failed prompt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-detach-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-detached'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const phases: string[] = [];
  await assert.rejects(runCodexAppServerTurn({ ...options('shared-detached'),
    sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', clientUserMessageId: 'code-ai:durable-run',
      onSubmissionChanged: state => { phases.push(state.deliveryPhase); } },
  }), (error: unknown) => error instanceof CodexAppServerDetachedError
    && error.submission.clientUserMessageId === 'code-ai:durable-run'
    && error.submission.queuedSubmissionId === 'queued-one' && error.submission.turnId === null
    && error.submission.deliveryPhase === 'detached');
  assert.deepEqual(phases, ['prepared', 'queued', 'detached']);
});

for (const mode of ['shared-recover-completed', 'shared-recover-pending', 'shared-recover-active', 'shared-recover-child', 'shared-recover-ambiguous']) {
  test(`${mode} reconciles stable native custody without sending the prompt twice`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-recovery-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new CodexUserInputRegistry();
    const run = runCodexAppServerTurn({ ...options(mode, registry), sessionId: 'parent-thread',
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', resumeSubmission: {
        clientUserMessageId: 'code-ai:recovered', queuedSubmissionId: 'queued-one', turnId: null, deliveryPhase: 'detached',
      } },
    });
    if (mode === 'shared-recover-ambiguous') {
      await assert.rejects(run, CodexAppServerDetachedError);
    } else if (mode === 'shared-recover-completed') {
      assert.equal((await run).lastMessage, 'Recovered final');
    } else {
      await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
      const request = registry.list('codex-test', 'parent-thread').requests[0];
      await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: request.id,
        answers: { choice: { answers: ['Custom target'] } } });
      assert.equal((await run).lastMessage, 'Done');
    }
  });
}

for (const race of [false, true]) test(`21MB recovered images and terminal-during-read race=${race} never resend input`, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'code-ai-large-recovery-'));
  const bridgePath=path.join(root,'adapter.cjs');
  await writeFile(bridgePath, `
    const rl=require('readline').createInterface({input:process.stdin});
    const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
    rl.on('line',raw=>{const f=JSON.parse(raw);if(!f.id)return;
      const result=r=>send({id:f.id,result:r});
      if(f.method==='initialize')result({});
      else if(f.method==='thread/resume')result({thread:{id:'parent-thread'}});
      else if(f.method==='thread/queue/list')result({data:[],nextCursor:null});
      else if(f.method==='thread/read')result({thread:{id:'parent-thread',historyMode:'paginated'}});
      else if(f.method==='thread/turns/list')result({data:[{id:'turn-one',status:${JSON.stringify(race?'inProgress':'completed')}}],nextCursor:null});
      else if(f.method==='thread/items/list'){
        ${race?"send({method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'turn-one',status:'completed'}}});":""}
        result({data:[{turnId:'turn-one',item:{type:'userMessage',clientId:'code-ai:recovered',content:Array.from({length:10},()=>({type:'image',url:'A'.repeat(2100000)}))}},{turnId:'turn-one',item:{type:'agentMessage',phase:'final_answer',text:'Recovered large final'}}],nextCursor:null});
      }else throw Error('Unexpected mutation during recovery');
    });
  `);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const phases:string[]=[];
  const result=await runCodexAppServerTurn({...options('large-recovery'),sessionId:'parent-thread',requestTimeoutMs:15000,
    sharedTransport:{bridgePath,socketPath:'/synthetic/not-installed',resumeSubmission:{clientUserMessageId:'code-ai:recovered',queuedSubmissionId:null,turnId:null,deliveryPhase:'detached'},onSubmissionChanged:s=>{phases.push(s.deliveryPhase);}}});
  assert.equal(result.lastMessage,'Recovered large final');assert.ok(phases.includes('running'));assert.ok(phases.includes('completed'));
});

for (const [initialMode, recoveredMode] of [['shared-detach-active', 'shared-recover-active'], ['shared-child-detach', 'shared-recover-child']]) {
test(`same-process ${recoveredMode} reattaches only its own detached native question without a new run or duplicate prompt`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-question-reattach-test-'));
  const initialBridge = path.join(root, 'synthetic-initial.cjs');
  const recoveredBridge = path.join(root, 'synthetic-recovery.cjs');
  await writeFile(initialBridge, fixture(initialMode));
  await writeFile(recoveredBridge, fixture(recoveredMode));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new CodexUserInputRegistry();
  const runId = 'same-durable-queue-run';
  let custody: CodexSharedSubmission | undefined;
  await assert.rejects(runCodexAppServerTurn({ ...options(initialMode, registry), runId,
    sharedTransport: { bridgePath: initialBridge, socketPath: '/synthetic/not-installed', clientUserMessageId: 'code-ai:recovered' },
  }), (error: unknown) => {
    assert.ok(error instanceof CodexAppServerDetachedError);
    custody = error.submission;
    return true;
  });
  assert.ok(custody);
  const detached = registry.list('codex-test', 'parent-thread');
  assert.equal(detached.requests.length, 1);
  assert.equal(detached.requests[0].status, 'failed');
  assert.equal(detached.requests[0].resolutionReason, 'native_detached');
  const requestId = detached.requests[0].id;
  const run = runCodexAppServerTurn({ ...options(recoveredMode, registry), runId, sessionId: 'parent-thread',
    sharedTransport: { bridgePath: recoveredBridge, socketPath: '/synthetic/not-installed', resumeSubmission: custody } });
  await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
  const recovered = registry.list('codex-test', 'parent-thread');
  assert.equal(recovered.requests.length, 1);
  assert.equal(recovered.requests[0].id, requestId);
  assert.equal(recovered.requests[0].runId, runId);
  await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId,
    answers: { choice: { answers: ['Custom target'] } } });
  assert.equal((await run).lastMessage, 'Done');
});
}

for (const mode of ['shared-recover-resolved-before-proof', 'shared-recover-child-resolved-before-proof']) {
  test(`${mode} cannot revive a question already resolved by a competing GUI client`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-resolved-replay-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new CodexUserInputRegistry();
    const runId = 'resolved-recovery-run';
    const ownParams = { threadId: mode.includes('child') ? 'child-thread' : 'parent-thread',
      turnId: mode.includes('child') ? 'child-turn' : 'turn-one', itemId: 'input-one', isBlocking: true,
      questions: [{ id: 'choice', header: 'Target', question: 'Where?', isOther: true, isSecret: false,
        options: [{ label: 'Local', description: 'Here' }] }] };
    const own = registry.register({ profileId: 'codex-test', sessionId: 'parent-thread', runId }, 77, ownParams, () => {});
    registry.clearRun(runId, 'failed', 'native_detached', 'codex-test');
    const foreign = registry.register({ profileId: 'codex-test', sessionId: 'parent-thread', runId: 'another-user-run' },
      77, { ...ownParams, threadId: 'foreign-thread' }, () => {});
    let recoveryRegistrations = 0;
    const originalRegister = registry.register.bind(registry);
    registry.register = (...args: Parameters<CodexUserInputRegistry['register']>) => {
      recoveryRegistrations++;
      return originalRegister(...args);
    };
    let finishOwn = () => {};
    const result = await runCodexAppServerTurn({ ...options(mode, registry), runId, sessionId: 'parent-thread',
      onSpawn: child => { finishOwn = () => { child.stdin.write(JSON.stringify({ method: 'synthetic/finish' }) + '\n'); }; },
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', resumeSubmission: {
        clientUserMessageId: 'code-ai:recovered', queuedSubmissionId: 'queued-one', turnId: null, deliveryPhase: 'detached',
      }, onSubmissionChanged: state => {
        if (!mode.includes('child') && state.deliveryPhase === 'running') finishOwn();
      } } });
    assert.equal(result.lastMessage, 'Done');
    assert.equal(recoveryRegistrations, 0);
    const requests = registry.list('codex-test', 'parent-thread').requests;
    assert.equal(requests.find(request => request.id === own.id)?.status, 'failed');
    assert.equal(requests.find(request => request.id === foreign.id)?.status, 'pending');
  });
}

for (const maxFrameBytes of [1024, 8 * 1024 * 1024]) {
  test(`recovery resolution tombstones are bounded by bytes and count (${maxFrameBytes}) without losing native custody`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-resolution-limit-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture('shared-recover-tombstone-overflow'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(runCodexAppServerTurn({ ...options('shared-recover-tombstone-overflow'), sessionId: 'parent-thread', maxFrameBytes,
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', resumeSubmission: {
        clientUserMessageId: 'code-ai:recovered', queuedSubmissionId: 'queued-one', turnId: null, deliveryPhase: 'detached',
      } } }), CodexAppServerDetachedError);
  });
}

test('recovery transport loss before initialization retains durable native work instead of claiming prompt failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-early-recovery-loss-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-recover-init-detached'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(runCodexAppServerTurn({ ...options('shared-recover-init-detached'), sessionId: 'parent-thread',
    sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', resumeSubmission: {
      clientUserMessageId: 'code-ai:recovered', queuedSubmissionId: 'queued-one', turnId: null, deliveryPhase: 'queued',
    } } }), CodexAppServerDetachedError);
});

test('already-aborted recovery cannot claim native cancellation without proof or submit another prompt', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(runCodexAppServerTurn({ ...options('shared'), signal: controller.signal,
    onSpawn: () => { spawned = true; }, sharedTransport: { bridgePath: '/not-used', socketPath: '/not-used', resumeSubmission: {
      clientUserMessageId: 'code-ai:recovered', queuedSubmissionId: 'queued-one', turnId: null, deliveryPhase: 'queued',
    } } }), CodexAppServerDetachedError);
  assert.equal(spawned, false);
});

test('shared cancellation removes only its own pending submission and never interrupts desktop work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-queue-cancel-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-cancel-pending'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let queued = false;
  const phases: string[] = [];
  const run = runCodexAppServerTurn({ ...options('shared-cancel-pending'), signal: controller.signal,
    sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed',
      onSubmissionChanged: state => { phases.push(state.deliveryPhase); if (state.queuedSubmissionId) queued = true; } },
  });
  const rejected = assert.rejects(run, CodexAppServerCancelledError);
  await waitFor(() => queued);
  controller.abort();
  await rejected;
  assert.deepEqual(phases, ['prepared', 'queued', 'cancelled']);
});

test('pending shared input invokes recovery with only durable IDs; lost ACK detaches without replay', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-recovery-callback-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-cancel-pending'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const calls: unknown[][] = [];
  let state: CodexSharedSubmission | undefined;
  const run = runCodexAppServerTurn({...options('shared-cancel-pending'),
    sharedTransport:{bridgePath,socketPath:'/synthetic/not-installed',
      onSubmissionChanged: s => {state=s;},
      recoverQueuedInput: async (...ids) => {calls.push(ids);throw Error('synthetic lost ACK');}}});
  await assert.rejects(run, CodexAppServerDetachedError);
  assert.deepEqual(calls,[['parent-thread','queued-one',state?.clientUserMessageId]]);
  assert.match(state?.clientUserMessageId || '', /^code-ai:/);
  assert.equal(state?.queuedSubmissionId,'queued-one');
  assert.equal(state?.turnId,null);
  assert.equal(state?.deliveryPhase,'detached');
});

test('recovering a queued input after app reconnect preserves its client ID and never enqueues again', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-resume-callback-test-'));
  const bridgePath = path.join(root,'synthetic-adapter.cjs');
  await writeFile(bridgePath,fixture('shared-recover-pending'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registry = new CodexUserInputRegistry(), calls:unknown[][]=[];
  const run=runCodexAppServerTurn({...options('shared-recover-pending',registry),sessionId:'parent-thread',
    sharedTransport:{bridgePath,socketPath:'/synthetic/not-installed',
      resumeSubmission:{clientUserMessageId:'code-ai:recovered',queuedSubmissionId:'queued-one',turnId:null,deliveryPhase:'queued'},
      recoverQueuedInput:async(...ids)=>{calls.push(ids);return 'busy';}}});
  await waitFor(()=>registry.list('codex-test','parent-thread').pendingCount===1);
  const question=registry.list('codex-test','parent-thread').requests[0];
  await registry.answer({profileId:'codex-test',sessionId:'parent-thread',requestId:question.id,
    answers:{choice:{answers:['Custom target']}}});
  assert.equal((await run).lastMessage,'Done');
  assert.deepEqual(calls,[['parent-thread','queued-one','code-ai:recovered']]);
});

for (const mode of ['shared-cancel-active', 'shared-cancel-unresolved']) {
  test(`${mode} waits for native own-turn cancellation proof rather than trusting an interrupt ACK`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-cancel-proof-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new CodexUserInputRegistry();
    const controller = new AbortController();
    const phases: string[] = [];
    const run = runCodexAppServerTurn({ ...options(mode, registry), signal: controller.signal,
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed',
        onSubmissionChanged: state => { phases.push(state.deliveryPhase); } } });
    const rejected = assert.rejects(run, mode === 'shared-cancel-active' ? CodexAppServerCancelledError : CodexAppServerDetachedError);
    await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
    controller.abort();
    await rejected;
    assert.equal(phases.at(-1), mode === 'shared-cancel-active' ? 'cancelled' : 'detached');
    if (mode === 'shared-cancel-unresolved') assert.equal(phases.includes('cancelled'), false);
  });
}

test('proven cancelled shared custody is terminal and can never resubmit a prompt during recovery', async () => {
  let spawned = false;
  const cancelled = { clientUserMessageId: 'code-ai:cancelled', queuedSubmissionId: 'queued-one', turnId: null,
    deliveryPhase: 'cancelled' as const };
  assert.equal(isCodexSharedSubmissionTerminal(cancelled), true);
  await assert.rejects(runCodexAppServerTurn({ ...options('shared'), onSpawn: () => { spawned = true; },
    sharedTransport: { bridgePath: '/not-used', socketPath: '/not-used', resumeSubmission: cancelled } }), CodexAppServerCancelledError);
  assert.equal(spawned, false);
});

test('shared queue refuses to silently discard requested model/config overrides', async () => {
  let spawned = false;
  await assert.rejects(runCodexAppServerTurn({ ...options('shared'), turnOptions: { model: 'requested-model' },
    onSpawn: () => { spawned = true; }, sharedTransport: { bridgePath: '/not-used', socketPath: '/not-used' },
  }), /explicit owner-settings inheritance/);
  assert.equal(spawned, false);
});

function expectedOwnerSettings(): CodexSharedOwnerSettings {
  return { model: 'synthetic-model', modelProvider: 'synthetic-provider', serviceTier: null,
    cwd: process.cwd(), approvalPolicy: 'never', reasoningEffort: 'high',
    sandbox: { type: 'workspaceWrite', writableRoots: ['/synthetic/workspace'], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
}

test('managed owner refuses a raw native endpoint before resuming or submitting input', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-managed-handshake-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-settings-no-enqueue'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let custodyCreated = false;
  await assert.rejects(runCodexAppServerTurn({ ...options('shared-settings-no-enqueue'),
    sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', managedOwner: true,
      expectedOwnerSettings: expectedOwnerSettings(), onSubmissionChanged: () => { custodyCreated = true; } },
  }), /qualified shared Codex owner is unavailable/);
  assert.equal(custodyCreated, false);
});

test('managed owner carries explicit execution settings to its atomic queue reservation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-managed-settings-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-managed'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new CodexUserInputRegistry();
  const expected: CodexSharedOwnerSettings = { model: 'synthetic-requested-model', reasoningEffort: 'xhigh',
    cwd: process.cwd(), approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
  const run = runCodexAppServerTurn({ ...options('shared-managed', registry),
    turnOptions: { model: expected.model, effort: 'xhigh' },
    sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', managedOwner: true,
      expectedOwnerSettings: expected } });
  await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
  const request = registry.list('codex-test', 'parent-thread').requests[0];
  await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: request.id,
    answers: { choice: { answers: ['Custom target'] } } });
  assert.equal((await run).lastMessage, 'Done');
});

test('managed new input cannot implicitly inherit another client execution settings', async () => {
  let spawned = false;
  await assert.rejects(runCodexAppServerTurn({ ...options('shared'),
    onSpawn: () => { spawned = true; },
    sharedTransport: { bridgePath: '/not-used', socketPath: '/not-used', managedOwner: true },
  }), /requires explicit per-turn settings/);
  assert.equal(spawned, false);
});

for (const mode of ['shared-managed-busy', 'shared-managed-uncertain']) {
  test(`managed ${mode} distinguishes proven nonacceptance from uncertain native custody`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-managed-admission-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mode));
    t.after(() => rm(root, { recursive: true, force: true }));
    const custody: CodexSharedSubmission[] = [];
    await assert.rejects(runCodexAppServerTurn({ ...options(mode),
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', managedOwner: true,
        expectedOwnerSettings: expectedOwnerSettings(), onSubmissionChanged: record => { custody.push(record); } },
    }), (error: unknown) => {
      if (mode === 'shared-managed-busy') {
        assert.ok(error instanceof CodexSharedAdmissionRejectedError);
        assert.equal(error.retryable, true);
      } else assert.ok(error instanceof CodexAppServerDetachedError);
      assert.equal((error as Error).message.includes('PRIVATE_ERROR'), false);
      return true;
    });
    assert.equal(custody.at(-1)?.deliveryPhase, mode === 'shared-managed-busy' ? 'prepared' : 'detached');
  });
}

test('shared native settings comparison is exact but ignores object property order', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-settings-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-settings-match'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new CodexUserInputRegistry();
  const expected = expectedOwnerSettings();
  expected.sandbox = { excludeSlashTmp: true, networkAccess: false, type: 'workspaceWrite',
    excludeTmpdirEnvVar: true, writableRoots: ['/synthetic/workspace'] };
  const run = runCodexAppServerTurn({ ...options('shared-settings-match', registry),
    turnOptions: { model: 'synthetic-model', effort: 'high' },
    sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', inheritOwnerSettings: true,
      expectedOwnerSettings: expected } });
  await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
  const request = registry.list('codex-test', 'parent-thread').requests[0];
  await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: request.id,
    answers: { choice: { answers: ['Custom target'] } } });
  assert.equal((await run).lastMessage, 'Done');
});

for (const mismatch of ['model', 'modelProvider', 'serviceTier', 'cwd', 'approvalPolicy', 'sandbox', 'reasoningEffort', 'missing']) {
  test(`shared native ${mismatch} mismatch fails closed before enqueue without exposing configuration`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-settings-reject-test-'));
    const bridgePath = path.join(root, 'synthetic-adapter.cjs');
    await writeFile(bridgePath, fixture(mismatch === 'missing' ? 'shared-settings-missing' : 'shared-settings-no-enqueue'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const expected = expectedOwnerSettings();
    if (mismatch === 'sandbox') expected.sandbox = { type: 'dangerFullAccess' };
    else if (mismatch === 'approvalPolicy') expected.approvalPolicy = 'on-request';
    else if (mismatch === 'serviceTier') expected.serviceTier = 'flex';
    else if (mismatch !== 'missing') Object.assign(expected, { [mismatch]: '/private-fixture-value-do-not-echo' });
    let recorded = false;
    await assert.rejects(runCodexAppServerTurn({ ...options('shared-settings-no-enqueue'),
      sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', expectedOwnerSettings: expected,
        onSubmissionChanged: () => { recorded = true; } } }), (error: unknown) => {
      assert.ok(error instanceof CodexSharedOwnerSettingsMismatchError);
      assert.equal(isCodexSharedOwnerSettingsMismatchError(error), true);
      assert.equal(error.message.includes('/private-fixture-value-do-not-echo'), false);
      return true;
    });
    assert.equal(recorded, false);
  });
}

test('resuming managed native threads never overwrites existing settings or permissions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-managed-resume-settings-test-'));
  const bridgePath = path.join(root, 'synthetic-adapter.cjs');
  await writeFile(bridgePath, fixture('shared-managed-resume'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new CodexUserInputRegistry();
  const expected: CodexSharedOwnerSettings = { model: 'synthetic-requested-model', reasoningEffort: 'xhigh',
    cwd: process.cwd(), approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
  const run = runCodexAppServerTurn({ ...options('shared-managed-resume', registry), sessionId: 'parent-thread',
    threadOptions: { model: 'must-not-override', config: { model_reasoning_effort: 'low' }, approvalPolicy: 'never', sandbox: 'danger-full-access' },
    sharedTransport: { bridgePath, socketPath: '/synthetic/not-installed', managedOwner: true,
      expectedOwnerSettings: expected } });
  await waitFor(() => registry.list('codex-test', 'parent-thread').pendingCount === 1);
  const request = registry.list('codex-test', 'parent-thread').requests[0];
  await registry.answer({ profileId: 'codex-test', sessionId: 'parent-thread', requestId: request.id,
    answers: { choice: { answers: ['Custom target'] } } });
  assert.equal((await run).lastMessage, 'Done');
});
