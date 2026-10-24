from pathlib import Path
import json,hashlib,sys
root=Path('/mnt/hdd/code-ai-builds/auth-cycle-source-20261016');p=root/'payload'
originals={f:f.read_bytes() for n in ['server/codexQueue.ts','server/codexRuntimeHealth.mjs','server/codexRuntimeHealth.test.mjs','server/codexAccountUsage.ts','server/codexAccountAuth.ts','server/codexService.ts','server/codexRoutes.ts','client/src/components/codex/CodexMobileApp.tsx'] for f in [p/n]}
def restore_on_failure(kind,value,traceback):
 for f,data in originals.items():f.write_bytes(data)
 sys.__excepthook__(kind,value,traceback)
sys.excepthook=restore_on_failure
def replace(file,old,new):
 f=p/file;s=f.read_text();assert s.count(old)==1,(file,old[:100],s.count(old));f.write_text(s.replace(old,new))
def replace_in_retry(old,new):
 f=p/'client/src/components/codex/CodexMobileApp.tsx';s=f.read_text();a=s.index('  async function retryQueueItem(');b=s.index('  async function deleteQueueItem(',a);part=s[a:b];assert part.count(old)==1;f.write_text(s[:a]+part.replace(old,new)+s[b:])
replace('server/codexQueue.ts','  clientRequestId?: string | null;\n  nativeSubmission?', '  clientRequestId?: string | null;\n  retryOfItemId?: string | null;\n  nativeSubmission?')
replace('server/codexQueue.ts',"  // Reusing this item would reuse its stable provider message ID, potentially\n  // adopting an old result instead of executing the explicit retry. A new\n  // native attempt identity is a separate unqualified lifecycle contract.\n  if (item.nativeSubmission) {\n    throw new Error('Native submission cannot be retried under the same message identity');\n  }",'''  if (item.nativeSubmission) {
    if (nativeSubmissionNeedsReconciliation(item.nativeSubmission)) {
      throw new Error('יש להמתין לאימות סיום הבקשה הקודמת לפני ניסיון נוסף.');
    }
    if (item.status === 'cancelled' && item.nativeSubmission.deliveryPhase !== 'cancelled') {
      throw new Error('הבקשה הסתיימה במנוע; יש לבדוק את התוצאה לפני שליחה נוספת.');
    }
    // One explicit retry per terminal attempt. Repeated clicks and a response
    // lost during login/cutover return the same child, never another prompt.
    const existing = state.items.find((candidate) => candidate.retryOfItemId === item.id);
    if (existing) return cloneQueueItem(existing);
    const retry = cloneQueueItem(item);
    const at = nowIso();
    Object.assign(retry, {
      id: randomUUID(), retryOfItemId: item.id, clientRequestId: `retry:${item.id}`,
      nativeSubmission: null, nativeCancellationRequestedAt: null, nativeReconcileAfter: null,
      scheduledAt: normalizeScheduledAt(scheduledAt), createdAt: at, updatedAt: at,
      startedAt: null, completedAt: null, finalMessage: null, error: null, attempts: 0,
      lastRunAt: null, lastRunStatus: null, stopPolicy: null,
    });
    retry.status = new Date(retry.scheduledAt).getTime() > Date.now() ? 'scheduled' : 'queued';
    if (isRecurringItem(retry)) {
      retry.scheduledAt = computeNextRecurringScheduledAt(retry, Date.now());
      retry.status = 'scheduled';
    }
    if (retry.stopDecisionForItemId) {
      const source = state.items.find((candidate) => candidate.id === retry.stopDecisionForItemId);
      if (source?.stopPolicy?.mode === 'conditional') {
        source.stopPolicy.decisionItemId = retry.id;
        source.stopPolicy.status = 'awaiting-decision';
        source.stopPolicy.resolvedAt = null; source.stopPolicy.decision = null;
        source.stopPolicy.outcome = null; source.stopPolicy.error = null;
      }
    }
    state.items.push(retry);
    await persistState();
    scheduleImmediateTick();
    return cloneQueueItem(retry);
  }''')
# No authentication result is reused after a completed probe. Concurrent reads
# still share their pending native RPC, with the original bounded deadline.
replace('server/codexRuntimeHealth.mjs','{maxAgeMs=10000,...options}', '{maxAgeMs=0,...options}')
replace('server/codexRuntimeHealth.mjs','const healthReads=new Map();','const healthReads=new Map();\nexport function invalidateCanonicalOwnerHealth(home){healthReads.delete(home)}')
f=p/'server/codexRuntimeHealth.mjs';s=f.read_text();a=s.index('export async function cachedCanonicalOwnerHealth(');b=s.index('export async function getCodeAiRuntimeHealth(',a)
f.write_text(s[:a]+'''export async function cachedCanonicalOwnerHealth(home, options={}) {
 const prior=healthReads.get(home);if(prior)return prior;
 const pending=probeCanonicalOwner(home,options);healthReads.set(home,pending);
 try{return await pending}finally{if(healthReads.get(home)===pending)healthReads.delete(home)}
}
'''+s[b:])
replace('server/codexRuntimeHealth.test.mjs',"cachedCanonicalOwnerHealth} from", "cachedCanonicalOwnerHealth,invalidateCanonicalOwnerHealth} from")
replace('server/codexRuntimeHealth.test.mjs',"concurrent health requests share a native read and cached calls do not create another connection", "concurrent health reads coalesce but authentication is read again after completion")
replace('server/codexRuntimeHealth.test.mjs',"assert.deepEqual(await cachedCanonicalOwnerHealth(f.home),a);assert.equal(f.methods.filter(m=>m==='initialize').length,1);\n await cachedCanonicalOwnerHealth(f.home,{maxAgeMs:0});assert.equal(f.methods.filter(m=>m==='initialize').length,2);", "assert.deepEqual(await cachedCanonicalOwnerHealth(f.home),{...a,elapsedMs:(await cachedCanonicalOwnerHealth(f.home)).elapsedMs});")
# Replace the final fixture with a stateful logout/login regression.
f=p/'server/codexRuntimeHealth.test.mjs';s=f.read_text();start=s.index("test('concurrent health reads coalesce")
s=s[:start]+'''test('concurrent health reads coalesce but authentication is read again after completion',async t=>{
 const f=await fixture(t);const [a,b]=await Promise.all([cachedCanonicalOwnerHealth(f.home),cachedCanonicalOwnerHealth(f.home)]);
 assert.equal(a.authenticated,true);assert.deepEqual(a,b);assert.equal(f.methods.filter(m=>m==='initialize').length,1);
 await cachedCanonicalOwnerHealth(f.home);assert.equal(f.methods.filter(m=>m==='initialize').length,2);
 invalidateCanonicalOwnerHealth(f.home);await cachedCanonicalOwnerHealth(f.home);assert.equal(f.methods.filter(m=>m==='initialize').length,3);
});
''';f.write_text(s)
replace('server/codexAccountUsage.ts','const accountUsageCache = new Map<string, AccountUsageCacheEntry>();', 'const accountUsageCache = new Map<string, AccountUsageCacheEntry>();\nconst accountUsageEpochs = new Map<string, symbol>();')
replace('server/codexAccountUsage.ts','  const resolvedHome = path.resolve(profile.codexHome);','  const resolvedHome = path.resolve(profile.codexHome);\n  accountUsageEpochs.set(resolvedHome, Symbol());')
replace('server/codexAccountUsage.ts','  const cacheKey = `${profile.id}\\u0000${path.resolve(profile.codexHome)}`;','  const resolvedHome = path.resolve(profile.codexHome);\n  const epoch = accountUsageEpochs.get(resolvedHome);\n  const cacheKey = `${profile.id}\\u0000${resolvedHome}`;')
f=p/'server/codexAccountUsage.ts';s=f.read_text();needle='accountUsageCache.set(cacheKey, { expiresAt: now() + ACCOUNT_USAGE_CACHE_TTL_MS, snapshot });';assert s.count(needle)==2;s=s.replace(needle,'if (accountUsageEpochs.get(resolvedHome) === epoch) '+needle);f.write_text(s)
replace('server/codexAccountAuth.ts',"import { getSharedAccountCommand } from './codexSharedAccountAuth.mjs';", "import { getSharedAccountCommand } from './codexSharedAccountAuth.mjs';\nimport { invalidateCanonicalOwnerHealth } from './codexRuntimeHealth.mjs';\nimport { invalidateCodexModelCatalogCache } from './codexService.js';")
replace('server/codexAccountAuth.ts','function accountCommand(profile:', '''function invalidateAccountState(profile: CodexAccountUsageProfile): void {
  clearCodexAccountUsageCache(profile);
  invalidateCanonicalOwnerHealth(profile.codexHome);
  invalidateCodexModelCatalogCache(profile.id);
}

function accountCommand(profile:''')
replace('server/codexAccountAuth.ts',"  if (state === 'authenticated') {\n    clearCodexAccountUsageCache({ id: flow.profileId, codexHome: flow.codexHomeKey });\n  }", "  invalidateAccountState({ id: flow.profileId, codexHome: flow.codexHomeKey });")
replace('server/codexAccountAuth.ts','  const startedAtMs = Date.now();','  invalidateAccountState(profile);\n  const startedAtMs = Date.now();')
replace('server/codexAccountAuth.ts','  await runCodexLogout(profile);','  invalidateAccountState(profile);\n  try { await runCodexLogout(profile); } finally { invalidateAccountState(profile); }')
replace('server/codexService.ts','const modelCatalogCache = new Map', 'let modelCatalogCacheEpoch = 0;\nconst modelCatalogCache = new Map')
replace('server/codexService.ts','async function loadCodexAvailableModels(profile: CodexProfile): Promise<CodexAvailableModel[]> {','async function loadCodexAvailableModels(profile: CodexProfile): Promise<CodexAvailableModel[]> {\n  const epoch = modelCatalogCacheEpoch;')
replace('server/codexService.ts','  modelCatalogCache.set(profile.id, {','  if (epoch === modelCatalogCacheEpoch) modelCatalogCache.set(profile.id, {')
replace('server/codexService.ts','export function invalidateCodexModelCatalogCache(profileId?: string): void {','export function invalidateCodexModelCatalogCache(profileId?: string): void {\n  modelCatalogCacheEpoch += 1;')
replace('server/codexRoutes.ts','const router = Router();', '''const router = Router();
router.use((req, res, next) => {
  if (['/auth/status','/device-unlock','/logout','/account-auth','/models','/rate-limits','/remote-agent/health']
      .some(prefix => req.path === prefix || req.path.startsWith(prefix + '/'))) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});''')
replace('client/src/components/codex/CodexMobileApp.tsx','return fetch(input, withCodeAiServerHeader(input, init, explicitServerId));',"return fetch(input, withCodeAiServerHeader(input, { ...init, cache: 'no-store' }, explicitServerId));")
replace_in_retry("        setQueueItems((current) => current.map((item) => (item.id === itemId ? data.item : item)));", "        setQueueItems((current) => data.item.id === itemId\n          ? current.map((item) => item.id === itemId ? data.item : item)\n          : [...current.filter((item) => item.id !== data.item.id), data.item]);")
replace('client/src/components/codex/CodexMobileApp.tsx', '      setRateLimitSnapshot(nextSnapshot);\n      setRateLimitError(null);\n      return;\n    }\n    await loadRateLimitSnapshot(profileId, selectedSessionId, true);', '''      latestRateLimitLoadTokenRef.current += 1;
      setRateLimitSnapshot(nextSnapshot);
      setRateLimitError(null);
    }
    await Promise.all([
      loadModelCatalog(profileId, true),
      ...(nextSnapshot === undefined ? [loadRateLimitSnapshot(profileId, selectedSessionId, true)] : []),
    ]);''')
# Fence polling responses that began before an explicit account mutation.
replace('client/src/components/codex/CodexMobileApp.tsx','  const handledAuthenticatedFlowRef = useRef<string | null>(null);','  const handledAuthenticatedFlowRef = useRef<string | null>(null);\n  const accountAuthEpochRef = useRef(0);')
replace('client/src/components/codex/CodexMobileApp.tsx','    const pollAuthStatus = async () => {\n      try {','    const pollAuthStatus = async () => {\n      const epoch = accountAuthEpochRef.current;\n      try {')
replace('client/src/components/codex/CodexMobileApp.tsx','        if (!disposed) {\n          setAccountAuth(next);','        if (!disposed && epoch === accountAuthEpochRef.current) {\n          setAccountAuth(next);')
replace('client/src/components/codex/CodexMobileApp.tsx','        if (!disposed) {\n          setAccountActionNotice({','        if (!disposed && epoch === accountAuthEpochRef.current) {\n          setAccountActionNotice({')
replace('client/src/components/codex/CodexMobileApp.tsx','      setAccountAuth(await startCodexDeviceAuthRequest(profileId));','      accountAuthEpochRef.current += 1;\n      const next = await startCodexDeviceAuthRequest(profileId);\n      accountAuthEpochRef.current += 1;\n      setAccountAuth(next);')
replace('client/src/components/codex/CodexMobileApp.tsx','      const next = await cancelCodexDeviceAuthRequest(profileId, accountAuth?.flowId || null);','      accountAuthEpochRef.current += 1;\n      const next = await cancelCodexDeviceAuthRequest(profileId, accountAuth?.flowId || null);\n      accountAuthEpochRef.current += 1;')
replace('client/src/components/codex/CodexMobileApp.tsx','      const nextSnapshot = await disconnectCodexAccountRequest(profileId);','      accountAuthEpochRef.current += 1;\n      const nextSnapshot = await disconnectCodexAccountRequest(profileId);\n      accountAuthEpochRef.current += 1;')
print(json.dumps({'stagePatched':str(root),'productionChanged':False}))
