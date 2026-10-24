import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const contextIndex = args.indexOf('--context');
if (contextIndex < 0 || !args[contextIndex + 1]) throw new Error('--context is required');
const context = JSON.parse(await readFile(args[contextIndex + 1], 'utf8'));
args.splice(contextIndex, 2);
const action = args.shift();
if (!['budget', 'plan', 'complete', 'status', 'park', 'case-report', 'case-execution'].includes(action)) {
  throw new Error('Use budget, plan, complete, status, park, case-report or case-execution');
}
if (context.version !== 1 || typeof context.runId !== 'string' || typeof context.token !== 'string'
    || !/^http:\/\/127\.0\.0\.1:\d+\/api\/codex\/work-mode-control$/.test(context.endpoint)) {
  throw new Error('Invalid local work-mode capability');
}
const jsonIndex = args.indexOf('--json');
const fileIndex = args.indexOf('--file');
const input = jsonIndex >= 0 ? JSON.parse(args[jsonIndex + 1])
  : fileIndex >= 0 ? JSON.parse(await readFile(args[fileIndex + 1], 'utf8')) : {};
const response = await fetch(context.endpoint, { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${context.token}` },
  body: JSON.stringify({ ...input, action, runId: context.runId }), signal: AbortSignal.timeout(30_000) });
const result = await response.json();
if (!response.ok) throw new Error(result.error || `Work-mode action failed (${response.status})`);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
