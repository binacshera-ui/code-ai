import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRationalModeStore, type StartRationalRunInput } from './codexRationalMode.js';

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeai-rational-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storageFile = path.join(directory, 'private', 'runs.json');
  let time = Date.parse('2026-10-20T10:00:00.000Z');
  const now = () => time;
  const store = createRationalModeStore({ storageFile, now });
  return { ...store, storageFile, now, advance: (ms: number) => { time += ms; },
    restart: () => createRationalModeStore({ storageFile, now }),
    start: async (overrides: Partial<StartRationalRunInput> & {declareBudget?: boolean} = {}) => {
      const {declareBudget = true, ...input} = overrides;
      const result = await store.startRationalRun({runId: 'queue-1', profileId: 'developer', sessionKey: 'session-1', ...input});
      if (result.token && result.run.enabled && declareBudget) result.run = await store.mutateRationalRun(result.run.runId, result.token, {action:'budget', planningMinutes:3});
      return result;
    },
  };
}

test('plan is frozen, sequential, evidenced and uses immutable cumulative deadlines', async (t) => {
  const f = await fixture(t);
  const { run, token } = await f.start();
  assert.equal(run.status, 'planning');
  assert.equal(run.deadlineAt, '2026-10-20T10:03:00.000Z');
  assert.ok(token);
  f.advance(60_000);
  const action = { action: 'plan', tasks: [{ title: 'Fix', estimatedMinutes: 2 }, { title: 'Verify', estimatedMinutes: 3 }] };
  const planned = await f.mutateRationalRun(run.runId, token!, action);
  assert.deepEqual(planned.tasks.map((task) => task.deadlineAt), ['2026-10-20T10:03:00.000Z', '2026-10-20T10:06:00.000Z']);
  assert.deepEqual(await f.mutateRationalRun(run.runId, token!, action), planned);
  await assert.rejects(f.mutateRationalRun(run.runId, token!, { ...action, tasks: [{ title: 'Other', estimatedMinutes: 15 }] }), { code: 'PLAN_FROZEN' });
  await assert.rejects(f.mutateRationalRun(run.runId, token!, { action: 'complete', taskId: planned.tasks[1].id, evidence: 'pass' }), { code: 'TASK_ORDER' });
  await assert.rejects(f.mutateRationalRun(run.runId, token!, { action: 'complete', taskId: planned.tasks[0].id, evidence: ' ' }), { code: 'INVALID_INPUT' });
  f.advance(30_000);
  const completed = await f.mutateRationalRun(run.runId, token!, { action: 'complete', taskId: planned.tasks[0].id, evidence: 'Tests passed' });
  assert.equal(completed.deadlineAt, planned.tasks[1].deadlineAt);
  const finished = await f.finishRationalRun(run.runId, 'completed');
  assert.equal(finished?.status, 'incomplete');
  assert.equal(finished?.tasks[0].status, 'completed');
  assert.equal(finished?.tasks[0].evidence, 'Tests passed');
});

test('late checkmark and late plan reject while expiry persists across restart', async (t) => {
  const f = await fixture(t);
  const { token } = await f.start();
  const plan = await f.mutateRationalRun('queue-1', token!, { action: 'plan', tasks: [{ title: 'Task', estimatedMinutes: 1 }] });
  f.advance(60_000);
  await assert.rejects(f.mutateRationalRun('queue-1', token!, { action: 'complete', taskId: plan.tasks[0].id, evidence: 'Late claim' }), { code: 'BUDGET_EXPIRED' });
  assert.equal((await f.restart().getRationalRun('queue-1'))?.status, 'expired');
  assert.equal((await f.dueRationalRuns()).length, 1);
  assert.equal((await f.finishRationalRun('queue-1', 'cancelled'))?.status, 'expired');
  assert.equal((await f.dueRationalRuns()).length, 0);
  const second = await f.start({ runId: 'queue-2' });
  f.advance(3 * 60_000);
  await assert.rejects(f.mutateRationalRun('queue-2', second.token!, { action: 'plan', tasks: [{ title: 'Restart timer', estimatedMinutes: 1 }] }), { code: 'BUDGET_EXPIRED' });
});

test('reads and scheduler reconcile expiry, start cannot reset an existing attempt', async (t) => {
  const f = await fixture(t);
  const started = await f.start();
  f.advance(4 * 60_000);
  const again = await f.start();
  assert.equal(again.token, null);
  assert.equal(again.run.attemptId, started.run.attemptId);
  assert.equal(again.run.deadlineAt, started.run.deadlineAt);
  assert.equal(again.run.status, 'expired');
  assert.equal((await f.listRationalRuns('developer', 'session-1'))[0].status, 'expired');
  await assert.rejects(f.start({ profileId: 'developer2' }), { code: 'RUN_CONFLICT' });
});

test('capability is scoped to immutable run and never exposed or stored in plaintext', async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const second = await f.start({ runId: 'queue-2' });
  await assert.rejects(f.authenticateRationalRun('queue-2', first.token!), { code: 'FORBIDDEN' });
  await assert.rejects(f.mutateRationalRun('queue-1', second.token!, { action: 'status' }), { code: 'FORBIDDEN' });
  const read = await f.authenticateRationalRun('queue-1', first.token!);
  assert.equal(Object.hasOwn(read, 'tokenHash'), false);
  const saved = await fs.readFile(f.storageFile, 'utf8');
  assert.equal(saved.includes(first.token!), false);
  assert.equal(saved.includes(second.token!), false);
  assert.equal((await fs.stat(f.storageFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(f.storageFile))).mode & 0o777, 0o700);
  assert.equal((await f.restart().authenticateRationalRun('queue-1', first.token!)).attemptId, first.run.attemptId);
});

test('full completion is explicit, idempotent and retained after native completion', async (t) => {
  const f = await fixture(t);
  const { token } = await f.start();
  const planned = await f.mutateRationalRun('queue-1', token!, { action: 'plan', tasks: [{ title: 'Test', estimatedMinutes: 1 }] });
  const action = { action: 'complete', taskId: planned.tasks[0].id, evidence: 'Integration receipt 42: passed' };
  const done = await f.mutateRationalRun('queue-1', token!, action);
  assert.equal(done.status, 'completed');
  assert.equal(done.deadlineAt, null);
  assert.deepEqual(await f.mutateRationalRun('queue-1', token!, action), done);
  await assert.rejects(f.mutateRationalRun('queue-1', token!, { ...action, evidence: 'Changed' }), { code: 'TASK_FROZEN' });
  f.advance(10 * 60_000);
  assert.equal((await f.dueRationalRuns()).length, 0);
  const end = await f.finishRationalRun('queue-1', 'completed');
  assert.equal(end?.status, 'completed');
  assert.deepEqual(await f.finishRationalRun('queue-1', 'failed'), end);
});

test('decision-only capabilities have no timer or missing-task failure', async (t) => {
  const f = await fixture(t);
  const { token, run } = await f.start({ enabled: false });
  assert.equal(run.status, 'running');
  assert.equal(run.deadlineAt, null);
  f.advance(1_000 * 60_000);
  assert.equal((await f.dueRationalRuns()).length, 0);
  assert.equal((await f.authenticateRationalRun('queue-1', token!)).status, 'running');
  await assert.rejects(f.mutateRationalRun('queue-1', token!, { action: 'plan', tasks: [] }), { code: 'BUDGET_DISABLED' });
  assert.equal((await f.finishRationalRun('queue-1', 'completed'))?.status, 'completed');
});

test('owner holds survive restart, cannot be released by a different conversation, and preserve failure', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.advance(3 * 60_000);
  const holds = await f.listRationalHolds();
  assert.equal(holds.length, 1);
  const restarted = f.restart();
  assert.equal((await restarted.listRationalHolds()).length, 1);
  await assert.rejects(restarted.releaseRationalRun('queue-1', 'other', 'session-1'), { code: 'FORBIDDEN' });
  const released = await restarted.releaseRationalRun('queue-1', 'developer', 'session-1');
  assert.equal(released.status, 'expired');
  assert.ok(released.holdReleasedAt);
  assert.equal((await restarted.listRationalHolds()).length, 0);
  assert.deepEqual(await restarted.releaseRationalRun('queue-1', 'developer', 'session-1'), released);
});

test('concurrent completions serialize and failed writes do not poison later work', async (t) => {
  const f = await fixture(t);
  const { token } = await f.start();
  const planned = await f.mutateRationalRun('queue-1', token!, { action: 'plan', tasks: [{ title: 'Test', estimatedMinutes: 2 }] });
  const blocker = `${f.storageFile}.backup`;
  await fs.rename(f.storageFile, blocker);
  await fs.mkdir(f.storageFile);
  await assert.rejects(f.mutateRationalRun('queue-1', token!, { action: 'complete', taskId: planned.tasks[0].id, evidence: 'first' }));
  await fs.rmdir(f.storageFile);
  await fs.rename(blocker, f.storageFile);
  const action = { action: 'complete', taskId: planned.tasks[0].id, evidence: 'second' };
  const results = await Promise.all([f.mutateRationalRun('queue-1', token!, action), f.mutateRationalRun('queue-1', token!, action)]);
  assert.equal(results[0].tasks[0].evidence, 'second');
  assert.deepEqual(results[0], results[1]);
});

test('bounded task validation and draft binding retain attempt and deadline', async (t) => {
  const f = await fixture(t);
  const { run, token } = await f.start({ sessionKey: 'draft:1' });
  for (const tasks of [[], Array(31).fill({ title: 'x', estimatedMinutes: 1 }), [{ title: 'x', estimatedMinutes: 241 }], [{ title: 'x', estimatedMinutes: Infinity }]]) {
    await assert.rejects(f.mutateRationalRun('queue-1', token!, { action: 'plan', tasks }), { code: 'INVALID_INPUT' });
  }
  const bound = await f.rebindRationalRun('queue-1', 'native-session');
  assert.equal(bound?.attemptId, run.attemptId);
  assert.equal(bound?.deadlineAt, run.deadlineAt);
  assert.equal((await f.listRationalRuns('developer', 'draft:1')).length, 0);
  assert.equal((await f.listRationalRuns('developer', 'native-session')).length, 1);
});

test('AI declares and freezes planning time; its task estimates are not capped by former user defaults', async t => {
  const f = await fixture(t);
  const {run,token} = await f.start({declareBudget:false});
  assert.equal(run.planningMinutes,null);
  assert.equal(run.planningDeadlineAt,null);
  assert.equal(run.taskMinutes,null);
  assert.equal(run.deadlineAt,'2026-10-20T10:02:00.000Z');
  await assert.rejects(f.mutateRationalRun(run.runId,token!,{action:'plan',tasks:[{title:'Implement',estimatedMinutes:20}]}),{code:'BUDGET_REQUIRED'});
  f.advance(15_000);
  const budget=await f.mutateRationalRun(run.runId,token!,{action:'budget',planningMinutes:4});
  assert.equal(budget.planningMinutes,4);
  assert.equal(budget.deadlineAt,'2026-10-20T10:04:15.000Z');
  assert.deepEqual(await f.mutateRationalRun(run.runId,token!,{action:'budget',planningMinutes:4}),budget);
  await assert.rejects(f.mutateRationalRun(run.runId,token!,{action:'budget',planningMinutes:5}),{code:'BUDGET_FROZEN'});
  const planned=await f.mutateRationalRun(run.runId,token!,{action:'plan',tasks:[{title:'Implement',estimatedMinutes:20},{title:'Verify',estimatedMinutes:7}]});
  assert.deepEqual(planned.tasks.map(t=>t.estimatedMinutes),[20,7]);
  assert.equal(planned.tasks[0].deadlineAt,'2026-10-20T10:20:15.000Z');
  assert.equal((await f.restart().getRationalRun(run.runId))?.planningMinutes,4);
});

test('missing AI budget and overrunning its chosen planning time both expire without self-extension', async t => {
  const f=await fixture(t);
  const first=await f.start({declareBudget:false});
  f.advance(120_000);
  await assert.rejects(f.mutateRationalRun(first.run.runId,first.token!,{action:'budget',planningMinutes:30}),{code:'BUDGET_EXPIRED'});
  const second=await f.start({runId:'queue-2',declareBudget:false});
  for(const n of[0,31,Infinity])await assert.rejects(f.mutateRationalRun(second.run.runId,second.token!,{action:'budget',planningMinutes:n}),{code:'INVALID_INPUT'});
  await f.mutateRationalRun(second.run.runId,second.token!,{action:'budget',planningMinutes:1});
  f.advance(60_000);
  await assert.rejects(f.mutateRationalRun(second.run.runId,second.token!,{action:'plan',tasks:[{title:'Late',estimatedMinutes:1}]}),{code:'BUDGET_EXPIRED'});
  assert.equal((await f.listRationalHolds()).length,2);
});

test('a persisted pre-upgrade run keeps its original timer and task cap', async t => {
  const f=await fixture(t);const {run,token}=await f.start();
  const stored=JSON.parse(await fs.readFile(f.storageFile,'utf8'));
  const prior=stored.runs[run.runId];delete prior.timingSource;delete prior.planningMinutes;delete prior.budgetDeclarationDeadlineAt;prior.taskMinutes=15;
  await fs.writeFile(f.storageFile,JSON.stringify(stored));
  const old=f.restart();
  assert.equal((await old.getRationalRun(run.runId))?.deadlineAt,run.deadlineAt);
  await assert.rejects(old.mutateRationalRun(run.runId,token!,{action:'budget',planningMinutes:20}),{code:'BUDGET_FROZEN'});
  await assert.rejects(old.mutateRationalRun(run.runId,token!,{action:'plan',tasks:[{title:'Too long for historical run',estimatedMinutes:20}]}),{code:'INVALID_INPUT'});
  assert.equal((await old.mutateRationalRun(run.runId,token!,{action:'plan',tasks:[{title:'Existing plan',estimatedMinutes:5}]})).status,'running');
});
