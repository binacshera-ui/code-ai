/** Pure accounting for provider-reported usage. No model calls or credentials. */
export const COUNTERS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

export function counters(value) {
  if (!value || COUNTERS.some(k => !Number.isSafeInteger(value[k]) || value[k] < 0)) return null;
  if (value.cached_input_tokens > value.input_tokens || value.reasoning_output_tokens > value.output_tokens
      || value.total_tokens !== value.input_tokens + value.output_tokens) return null;
  return Object.fromEntries(COUNTERS.map(k => [k, value[k]]));
}

export function modelKey(context) {
  return JSON.stringify([context.model || 'unknown', context.speed || 'unknown']);
}

export function initialCursor({ createdAt, model = null, effort = null } = {}) {
  return { createdAt: createdAt || null, offset: 0, identity: null, baseline: null,
    recordBaseline: null, recordMode: false, generation: 0,
    model, speed: 'unknown', effort: effort || 'unknown', modelSource: model ? 'thread-index' : 'unknown' };
}

/** Update a cursor. Rows before a copied fork's creation only establish baseline. */
export function consumeRow(cursor, row, { bootstrap = false, measurementStartedAt, offset = 0 } = {}) {
  if (!row || typeof row !== 'object') return {};
  const p = row.payload || {};
  const inherited = cursor.createdAt && row.timestamp && row.timestamp < cursor.createdAt;
  if (row.type === 'turn_context' && !inherited) {
    cursor.model = typeof p.model === 'string' ? p.model : null;
    cursor.modelSource = cursor.model ? 'turn-context' : 'unknown';
    // Absence is unknown, not Standard. Never borrow current config as history.
    cursor.speed = typeof p.service_tier === 'string' ? p.service_tier : 'unknown';
    cursor.effort = typeof p.effort === 'string' ? p.effort : 'unknown';
  }
  if (row.type === 'event_msg' && p.type === 'model_reroute' && !inherited) {
    if (typeof p.to_model !== 'string' || !p.to_model.trim()) return { gap: 'unresolved-model-reroute' };
    cursor.model = p.to_model;
    cursor.modelSource = 'provider-reroute';
    cursor.speed = 'unknown';
  }
  if (row.type === 'event_msg' && p.type === 'thread_settings_applied' && !inherited) {
    const s = p.thread_settings || {};
    if (typeof s.model === 'string') { cursor.model = s.model; cursor.modelSource = 'thread-settings'; }
    cursor.speed = typeof s.service_tier === 'string' ? s.service_tier : 'unknown';
    cursor.effort = typeof s.reasoning_effort === 'string' ? s.reasoning_effort : 'unknown';
  }
  const record = row.type === 'token_usage_record' || p.type === 'token_usage_record';
  if (!record && (row.type !== 'event_msg' || p.type !== 'token_count' || !p.info)) return {};
  const wasRecordMode = cursor.recordMode;
  const current = counters(record ? p.thread_token_usage : p.info.total_token_usage);
  if (!current) return { gap: 'invalid-or-missing-counters' };
  const previous = record ? cursor.recordBaseline : cursor.baseline;
  if (record) { cursor.recordMode = true; cursor.recordBaseline = current; }
  else { cursor.baseline = current; if (cursor.recordMode) return {}; }
  if (bootstrap || inherited || !row.timestamp || row.timestamp < measurementStartedAt) return {};
  // These cumulative streams diverge after compaction. Never subtract one
  // stream from the other. A mid-measurement transition establishes a new
  // baseline and exposes its one uncertain boundary as a coverage gap.
  if (record && !wasRecordMode && cursor.baseline && !previous) return { gap: 'usage-ledger-transition' };
  if (!previous) return { gap: 'missing-initial-baseline' };
  if (COUNTERS.some(k => current[k] < previous[k])) return { gap: 'counter-discontinuity' };
  if (current.total_tokens === previous.total_tokens) return {};
  const delta = Object.fromEntries(COUNTERS.map(k => [k, current[k] - previous[k]]));
  if (!counters(delta)) return { gap: 'counter-correction' };
  return { event: { timestamp: row.timestamp, offset, model: cursor.model || 'unknown',
    speed: cursor.speed, effort: cursor.effort, modelSource: cursor.modelSource,
    counterSource: record ? 'canonical-thread-token-usage' : 'legacy-token-count',
    modelKey: modelKey(cursor), ...delta,
    uncached_input_tokens: delta.input_tokens - delta.cached_input_tokens } };
}

export function weeklyQuota(payload) {
  const candidates = [payload?.rate_limit?.primary_window,payload?.rate_limit?.secondary_window]
    .filter(w => w?.limit_window_seconds === 604800);
  if (candidates.length !== 1) return null;
  const window = candidates[0];
  if (!window
      || typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)
      || window.used_percent < 0 || window.used_percent > 100 || !Number.isSafeInteger(window.reset_at)) return null;
  return { usedPercent: window.used_percent, resetsAt: window.reset_at,
    planType: typeof payload.plan_type === 'string' ? payload.plan_type : 'unknown',
    limitReached: payload.rate_limit.limit_reached === true,
    windowSeconds: window.limit_window_seconds, quotaGroup: 'codex-standard' };
}

export function allocation(config) {
  const monthly = config.monthlyUsd;
  if (!Number.isFinite(monthly) || monthly <= 0) throw new Error('monthlyUsd must be positive');
  let days = 365.2425 / 12, basis = 'annualized-average';
  if (config.billingStart || config.billingEnd) {
    const start = Date.parse(config.billingStart), end = Date.parse(config.billingEnd);
    days = (end - start) / 86400000;
    if (!Number.isFinite(days) || days < 20 || days > 40) throw new Error('Invalid billing cycle');
    basis = 'configured-billing-cycle';
  }
  const weeklyAllocatedUsd = monthly * 7 / days;
  return { monthlyUsd: monthly, basis, billingCycleDays: days, weeklyAllocatedUsd,
    usdPerWeeklyPercentagePoint: weeklyAllocatedUsd / 100,
    assumption: 'entire-subscription-allocated-to-one-weekly-pool',
    additionalCashChargeUsd: 0, additionalCashChargeScope: 'passive-sampler-only' };
}

/** The provider's derived reset timestamp can jitter by a second per read. */
export function sameQuotaEpoch(a,b) {
  return Boolean(a?.quota && b?.quota && a.accountKey === b.accountKey
    && a.quota.planType === b.quota.planType && a.quota.quotaGroup === b.quota.quotaGroup
    && Math.abs(a.quota.resetsAt-b.quota.resetsAt) <= 120);
}

function totals(events) {
  const result = Object.fromEntries([...COUNTERS, 'uncached_input_tokens'].map(k => [k, 0]));
  for (const e of events) for (const k of Object.keys(result)) result[k] += e[k] || 0;
  return result;
}

export function buildReport({ snapshots, events, gaps = [], config, startedAt, now = new Date().toISOString(),
  modelTotals = null, savedSegments = null, pendingState = undefined }) {
  const money = allocation(config);
  const eligible = [], excluded = [], groups = new Map();
  for (const e of events) {
    let g = groups.get(e.modelKey);
    if (!g) { g = { model: e.model, speed: e.speed, events: [], efforts: {} }; groups.set(e.modelKey, g); }
    g.events.push(e); g.efforts[e.effort] = (g.efforts[e.effort] || 0) + 1;
  }
  if (modelTotals) for (const m of modelTotals) groups.set(m.modelKey, { ...m, events: [] });
  let anchor = null, previous = null;
  const minDelta = config.minimumQuotaDelta ?? 5;
  const minSeconds = config.minimumSegmentSeconds ?? 300;
  const sorted = [...snapshots].sort((a,b) => a.timestamp.localeCompare(b.timestamp));
  for (const s of sorted) {
    if (!s.quota) { anchor = null; previous = null; continue; }
    if (!anchor || !sameQuotaEpoch(anchor,s) || s.quota.usedPercent < previous.quota.usedPercent
        || Date.parse(s.timestamp) - Date.parse(previous.timestamp) > 180000) {
      anchor = s; previous = s; continue;
    }
    const delta = s.quota.usedPercent - anchor.quota.usedPercent;
    const seconds = (Date.parse(s.timestamp) - Date.parse(anchor.timestamp)) / 1000;
    previous = s;
    if (delta < minDelta || seconds < minSeconds) continue;
    const inRange = x => x.timestamp > anchor.timestamp && x.timestamp <= s.timestamp;
    const measured = events.filter(e => inRange(e) && e.accountKey === s.accountKey);
    const keys = new Set(measured.map(e => e.modelKey));
    const segment = { start: anchor.timestamp, end: s.timestamp, quotaDelta: delta,
      accountKey: s.accountKey, resetsAt: s.quota.resetsAt, ...totals(measured),
      usageIncrements: measured.length, models: [...keys] };
    let reason = null;
    if (s.quota.usedPercent >= 100 || anchor.quota.usedPercent >= 100) reason = 'quota-saturated';
    else if (gaps.some(inRange)) reason = 'telemetry-gap';
    else if (keys.size !== 1) reason = keys.size ? 'mixed-models-or-speeds' : 'no-local-usage';
    else if (measured.some(e => e.model === 'unknown')) reason = 'unknown-model';
    if (reason) excluded.push({ ...segment, reason });
    else {
      // Explicit quantization envelope, NOT a statistical confidence interval.
      eligible.push({ ...segment, modelKey: [...keys][0],
        percentLow: Math.max(0, delta - 2), percentHigh: Math.min(100, delta + 2),
        attribution: 'single-local-model-observed-external-usage-unverified' });
    }
    anchor = s;
  }
  if (savedSegments) {
    eligible.splice(0, eligible.length, ...savedSegments.filter(s => !s.reason));
    excluded.splice(0, excluded.length, ...savedSegments.filter(s => s.reason));
  }
  const byModel = [...groups.entries()].map(([key,g]) => {
    const samples = eligible.filter(s => s.modelKey === key), t = g.totals || totals(g.events);
    const n = samples.reduce((s,x) => s + x.total_tokens, 0);
    const low = samples.reduce((s,x) => s + x.percentLow, 0);
    const high = samples.reduce((s,x) => s + x.percentHigh, 0);
    const observed = samples.reduce((s,x) => s + x.quotaDelta, 0);
    return { modelKey: key, model: g.model, speed: g.speed, efforts: g.efforts,
      ...t, usageIncrements: g.usageIncrements ?? g.events.length, calibrationSegments: samples.length,
      calibration: n ? { status: 'tentative-observational-not-causal', measuredTokens: n,
        observedQuotaPercentagePoints: observed,
        quotaPointsPerMillionObservedTokens: { low: low * 1e6 / n, central: observed * 1e6 / n, high: high * 1e6 / n },
        allocatedUsdPerMillionObservedTokens: { low: low * money.usdPerWeeklyPercentagePoint * 1e6 / n,
          central: observed * money.usdPerWeeklyPercentagePoint * 1e6 / n,
          high: high * money.usdPerWeeklyPercentagePoint * 1e6 / n },
        observedTokenMix: totals(samples),
        separateInputOutputPrices: null,
        limitations: ['unverified-external-usage', 'provider-reporting-delay', 'observed-token-mix-only',
          'requested-model-unless-provider-reroute-is-persisted',
          ...(g.speed === 'unknown' ? ['unknown-speed-mode'] : [])] }
        : { status: 'insufficient-observations', separateInputOutputPrices: null } };
  }).sort((a,b) => b.total_tokens - a.total_tokens);
  return { version: 1, generatedAt: now, startedAt, profileId: config.profileId,
    mode: 'passive-real-workloads', modelRequestsCreated: 0, money,
    latestQuota: sorted.at(-1) || null, coverageGaps: gaps.length,
    observedTokens: modelTotals ? totals(modelTotals.map(m => m.totals)) : totals(events),
    usageIncrements: modelTotals ? modelTotals.reduce((s,m) => s+m.usageIncrements,0) : events.length,
    byModel, calibrationSegments: eligible, excludedSegments: excluded,
    pending: pendingState !== undefined ? pendingState : anchor ? { start: anchor.timestamp,
      quotaDelta: previous.quota.usedPercent - anchor.quota.usedPercent,
      minimumQuotaDelta: minDelta, minimumSegmentSeconds: minSeconds } : null,
    limitations: ['local-host-only', 'external-account-usage-unverified', 'no-synthetic-load',
      'no-official-fractional-quota-inference', 'subscription-allocation-not-provider-billing'] };
}

export function renderMarkdown(r) {
  const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
  const safe = s => String(s).replace(/[|\n\r]/g, ' ');
  const q = r.latestQuota;
  return `# מדידת מכסת המנוי — לפי מודל\n\nעודכן: ${r.generatedAt}\n\n` +
    `תחילת המדידה: ${r.startedAt}. פרופיל: ${safe(r.profileId)}. מצב: מדידה פסיבית של עבודה אמיתית.\n\n` +
    `מכסה שבועית אחרונה: ${q?.quota ? fmt(q.quota.usedPercent) + '% נוצל; איפוס ' + new Date(q.quota.resetsAt * 1000).toISOString() : 'לא זמינה'}\n\n` +
    `מנוי: $${fmt(r.money.monthlyUsd)} לחודש; הקצאה שבועית: $${fmt(r.money.weeklyAllocatedUsd)}; שווי נקודת אחוז: $${fmt(r.money.usdPerWeeklyPercentagePoint)}. בסיס: ${r.money.basis}.\n\n` +
    `זהו שיוך יחסי של מחיר המנוי למכסה אחת, לא חיוב API ולא הוצאה נוספת.\n\n` +
    `| מודל | מהירות | קלט רגיל | קלט ממטמון | פלט כולל חשיבה | מקטעי כיול | אומדן למיליון טוקנים בתמהיל שנמדד |\n|---|---|---:|---:|---:|---:|---|\n` +
    r.byModel.map(m => `| ${safe(m.model)} | ${safe(m.speed)} | ${fmt(m.uncached_input_tokens)} | ${fmt(m.cached_input_tokens)} | ${fmt(m.output_tokens)} | ${m.calibrationSegments} | ${m.calibration.allocatedUsdPerMillionObservedTokens ? '$' + fmt(m.calibration.allocatedUsdPerMillionObservedTokens.central) + ' (טווח עיגול בלבד $' + fmt(m.calibration.allocatedUsdPerMillionObservedTokens.low) + '–$' + fmt(m.calibration.allocatedUsdPerMillionObservedTokens.high) + ')' : 'אין די נתונים'} |`).join('\n') +
    `\n\nסך טוקנים שנצפו: ${fmt(r.observedTokens.total_tokens)}; פערי כיסוי: ${r.coverageGaps}.\n\n` +
    `מקטעים שלא שימשו לכיול: ${r.excludedSegments.length}.\n\n` +
    (r.preliminary ? `## יחס ראשוני מאוד — לא כיול מאומת\n\n` +
      `במודל ${safe(r.preliminary.model)} נצפו ${fmt(r.preliminary.observedTokens)} טוקנים מול עלייה של ${fmt(r.preliminary.quotaPercentagePoints)} נקודות אחוז שבועיות: ` +
      `כ־${fmt(r.preliminary.tokensPerWeeklyPercentagePoint)} טוקנים לנקודת אחוז, או כ־$${fmt(r.preliminary.allocatedUsdPerMillionObservedTokens)} למיליון טוקנים בתמהיל שנצפה. ` +
      `כ־${fmt((r.preliminary.cachedShareOfInput || 0)*100)}% מהקלט הגיעו מהמטמון. ` +
      `טווח עיגול בלבד: $${fmt(r.preliminary.roundingEnvelopeOnlyUsdPerMillion.low)}–$${fmt(r.preliminary.roundingEnvelopeOnlyUsdPerMillion.high)} למיליון; אינו כולל השהיית ספק או שימוש חיצוני. ` +
      `פערי כיסוי היסטוריים: ${r.preliminary.historicalCoverageGaps}. אין מכאן מחיר עצמאי לקלט או לפלט.\n\n` : '') +
    `הכיול זקוק למקטע של לפחות ${r.pending?.minimumQuotaDelta ?? 5} נקודות אחוז ו־${r.pending?.minimumSegmentSeconds ?? 300} שניות. ` +
    `אין כאן מחיר עצמאי לקלט או לפלט: דרוש מדגם שמאפשר להפריד ביניהם. ` +
    `טוקני המטמון כלולים בקלט; טוקני החשיבה כלולים בפלט ואינם נספרים פעם נוספת. ` +
    `שימוש ממכשירים אחרים והשהיית דיווח הספק אינם ניתנים לבידוד אוטומטי. מהירות חסרה נשארת unknown. ` +
    `שיוך המודל הוא לפי ההקשר המקומי; מעבר ספק למודל אחר מזוהה רק כאשר הוא נרשם בקובץ.\n`;
}
