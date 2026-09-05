import { promises as fs } from 'node:fs';
import path from 'node:path';

const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CHATGPT_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const ACCOUNT_USAGE_CACHE_TTL_MS = 30_000;

export interface CodexAccountUsageProfile {
  id: string;
  codexHome: string;
}

export interface CodexAccountUsageWindow {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
  resetsAtIso: string | null;
}

export interface CodexAccountQuotaGroup {
  id: string;
  label: string;
  meteredFeature: string | null;
  normalModelSlug: string | null;
  allowed: boolean | null;
  limitReached: boolean | null;
  primary: CodexAccountUsageWindow | null;
  secondary: CodexAccountUsageWindow | null;
}

export interface CodexBillingCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  overageLimitReached: boolean | null;
  balance: string | null;
  approximateLocalMessages: [number, number] | null;
  approximateCloudMessages: [number, number] | null;
}

export interface CodexResetCredit {
  id: string;
  resetType: string | null;
  title: string;
  status: string;
  grantedAt: string | null;
  expiresAt: string | null;
  description: string | null;
}

export interface CodexResetCreditsSnapshot {
  availableCount: number;
  applicableAvailableCount: number | null;
  totalEarnedCount: number;
  immediateResetPurchaseEligible: boolean | null;
  historyEnabled: boolean | null;
  credits: CodexResetCredit[];
}

export interface CodexAccountUsageSnapshot {
  source: 'chatgpt-wham';
  fetchedAt: string;
  account: {
    authenticated: boolean;
    email: string | null;
    accountIdMasked: string | null;
  };
  planType: string | null;
  rateLimitReachedType: string | null;
  quotaGroups: CodexAccountQuotaGroup[];
  billingCredits: CodexBillingCredits | null;
  resetCredits: CodexResetCreditsSnapshot | null;
  error: string | null;
}

interface AccountUsageCacheEntry {
  expiresAt: number;
  snapshot: CodexAccountUsageSnapshot;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  input: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

const accountUsageCache = new Map<string, AccountUsageCacheEntry>();

export function clearCodexAccountUsageCache(profile: CodexAccountUsageProfile): void {
  const resolvedHome = path.resolve(profile.codexHome);
  for (const cacheKey of accountUsageCache.keys()) {
    const separatorIndex = cacheKey.indexOf('\u0000');
    const cachedHome = separatorIndex >= 0 ? cacheKey.slice(separatorIndex + 1) : '';
    if (cacheKey.startsWith(`${profile.id}\u0000`) || cachedHome === resolvedHome) {
      accountUsageCache.delete(cacheKey);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readCount(value: unknown, fallback = 0): number {
  const parsed = readNumber(value);
  return parsed === null ? fallback : Math.max(0, Math.floor(parsed));
}

function readMessageRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const minimum = readNumber(value[0]);
  const maximum = readNumber(value[1]);
  return minimum === null || maximum === null ? null : [minimum, maximum];
}

export function maskCodexAccountId(value: unknown): string | null {
  const accountId = readString(value);
  if (!accountId) {
    return null;
  }
  if (accountId.length <= 10) {
    return `${accountId.slice(0, 3)}…${accountId.slice(-2)}`;
  }
  return `${accountId.slice(0, 7)}…${accountId.slice(-4)}`;
}

export function parseCodexAccountUsageWindow(value: unknown): CodexAccountUsageWindow | null {
  const window = asRecord(value);
  if (!window) {
    return null;
  }

  const usedPercent = readNumber(window.used_percent);
  const limitWindowSeconds = readNumber(window.limit_window_seconds);
  const resetsAt = readNumber(window.reset_at);
  if (usedPercent === null && limitWindowSeconds === null && resetsAt === null) {
    return null;
  }

  return {
    usedPercent,
    windowMinutes: limitWindowSeconds === null ? null : limitWindowSeconds / 60,
    resetsAt,
    resetsAtIso: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
  };
}

function parseQuotaGroup(
  value: unknown,
  fallback: { id: string; label: string; meteredFeature?: string | null; normalModelSlug?: string | null }
): CodexAccountQuotaGroup | null {
  const wrapper = asRecord(value);
  if (!wrapper) {
    return null;
  }
  const rateLimit = asRecord(wrapper.rate_limit) || wrapper;
  const primary = parseCodexAccountUsageWindow(rateLimit.primary_window);
  const secondary = parseCodexAccountUsageWindow(rateLimit.secondary_window);
  if (!primary && !secondary && readBoolean(rateLimit.allowed) === null && readBoolean(rateLimit.limit_reached) === null) {
    return null;
  }

  return {
    id: readString(wrapper.metered_feature) || readString(wrapper.limit_name) || fallback.id,
    label: readString(wrapper.limit_name) || fallback.label,
    meteredFeature: readString(wrapper.metered_feature) || fallback.meteredFeature || null,
    normalModelSlug: readString(wrapper.normal_model_slug) || fallback.normalModelSlug || null,
    allowed: readBoolean(rateLimit.allowed),
    limitReached: readBoolean(rateLimit.limit_reached),
    primary,
    secondary,
  };
}

function parseBillingCredits(value: unknown): CodexBillingCredits | null {
  const credits = asRecord(value);
  if (!credits) {
    return null;
  }
  return {
    hasCredits: readBoolean(credits.has_credits),
    unlimited: readBoolean(credits.unlimited),
    overageLimitReached: readBoolean(credits.overage_limit_reached),
    balance: readString(credits.balance),
    approximateLocalMessages: readMessageRange(credits.approx_local_messages),
    approximateCloudMessages: readMessageRange(credits.approx_cloud_messages),
  };
}

function parseResetCredit(value: unknown, index: number): CodexResetCredit | null {
  const credit = asRecord(value);
  if (!credit) {
    return null;
  }
  return {
    id: readString(credit.id) || `reset-credit-${index + 1}`,
    resetType: readString(credit.reset_type),
    title: readString(credit.title) || 'Full reset',
    status: readString(credit.status) || 'unknown',
    grantedAt: readString(credit.granted_at),
    expiresAt: readString(credit.expires_at),
    description: readString(credit.description),
  };
}

export function parseCodexUsagePayload(value: unknown): {
  accountId: string | null;
  email: string | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  quotaGroups: CodexAccountQuotaGroup[];
  billingCredits: CodexBillingCredits | null;
  resetCreditCounts: { availableCount: number; applicableAvailableCount: number | null } | null;
} {
  const usage = asRecord(value) || {};
  const quotaGroups: CodexAccountQuotaGroup[] = [];
  const standardQuota = parseQuotaGroup(usage.rate_limit, {
    id: 'codex-standard',
    label: 'Codex רגיל',
  });
  if (standardQuota) {
    quotaGroups.push(standardQuota);
  }

  if (Array.isArray(usage.additional_rate_limits)) {
    usage.additional_rate_limits.forEach((item, index) => {
      const parsed = parseQuotaGroup(item, {
        id: `codex-additional-${index + 1}`,
        label: `מכסת Codex נוספת ${index + 1}`,
      });
      if (parsed) {
        quotaGroups.push(parsed);
      }
    });
  }

  const resetCounts = asRecord(usage.rate_limit_reset_credits);
  return {
    accountId: readString(usage.account_id),
    email: readString(usage.email),
    planType: readString(usage.plan_type),
    rateLimitReachedType: readString(usage.rate_limit_reached_type),
    quotaGroups,
    billingCredits: parseBillingCredits(usage.credits),
    resetCreditCounts: resetCounts
      ? {
          availableCount: readCount(resetCounts.available_count),
          applicableAvailableCount: readNumber(resetCounts.applicable_available_count),
        }
      : null,
  };
}

export function parseCodexResetCreditsPayload(
  value: unknown,
  usageCounts: { availableCount: number; applicableAvailableCount: number | null } | null = null
): CodexResetCreditsSnapshot | null {
  const payload = asRecord(value);
  if (!payload && !usageCounts) {
    return null;
  }
  const credits = Array.isArray(payload?.credits)
    ? payload.credits
        .map((credit, index) => parseResetCredit(credit, index))
        .filter((credit): credit is CodexResetCredit => Boolean(credit))
    : [];

  return {
    availableCount: payload
      ? readCount(payload.available_count, usageCounts?.availableCount || 0)
      : usageCounts?.availableCount || 0,
    applicableAvailableCount: usageCounts?.applicableAvailableCount ?? null,
    totalEarnedCount: payload ? readCount(payload.total_earned_count) : 0,
    immediateResetPurchaseEligible: readBoolean(payload?.immediate_reset_purchase_eligible),
    historyEnabled: readBoolean(payload?.history_enabled),
    credits,
  };
}

function describeReadError(label: string, error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return `${label}: פג זמן ההמתנה`;
  }
  return `${label}: הנתונים אינם זמינים כרגע`;
}

async function readJsonResponse(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function loadCodexAccountUsage(
  profile: CodexAccountUsageProfile,
  options: { forceRefresh?: boolean; fetchImpl?: FetchLike; now?: () => number } = {}
): Promise<CodexAccountUsageSnapshot> {
  const now = options.now || Date.now;
  const cacheKey = `${profile.id}\u0000${path.resolve(profile.codexHome)}`;
  const cached = accountUsageCache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > now()) {
    return cached.snapshot;
  }

  const fetchedAt = new Date(now()).toISOString();
  let auth: Record<string, unknown> | null = null;
  try {
    auth = asRecord(JSON.parse(await fs.readFile(path.join(profile.codexHome, 'auth.json'), 'utf8')));
  } catch {
    // The panel should remain usable for unauthenticated or API-key-only profiles.
  }
  const tokens = asRecord(auth?.tokens);
  const accessToken = readString(tokens?.access_token);
  const authAccountId = readString(tokens?.account_id);

  if (!accessToken || !authAccountId) {
    const snapshot: CodexAccountUsageSnapshot = {
      source: 'chatgpt-wham',
      fetchedAt,
      account: {
        authenticated: false,
        email: null,
        accountIdMasked: maskCodexAccountId(authAccountId),
      },
      planType: null,
      rateLimitReachedType: null,
      quotaGroups: [],
      billingCredits: null,
      resetCredits: null,
      error: 'הפרופיל אינו מחובר לחשבון ChatGPT עם נתוני שימוש.',
    };
    accountUsageCache.set(cacheKey, { expiresAt: now() + ACCOUNT_USAGE_CACHE_TTL_MS, snapshot });
    return snapshot;
  }

  const fetchImpl = options.fetchImpl || (fetch as unknown as FetchLike);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'ChatGPT-Account-ID': authAccountId,
    'OpenAI-Beta': 'codex-1',
  };
  const [usageResult, resetCreditsResult] = await Promise.allSettled([
    readJsonResponse(fetchImpl, CHATGPT_USAGE_URL, headers),
    readJsonResponse(fetchImpl, CHATGPT_RESET_CREDITS_URL, headers),
  ]);
  const usage = usageResult.status === 'fulfilled'
    ? parseCodexUsagePayload(usageResult.value)
    : parseCodexUsagePayload(null);
  const resetCredits = parseCodexResetCreditsPayload(
    resetCreditsResult.status === 'fulfilled' ? resetCreditsResult.value : null,
    usage.resetCreditCounts
  );
  const errors = [
    usageResult.status === 'rejected' ? describeReadError('מכסות', usageResult.reason) : null,
    resetCreditsResult.status === 'rejected' ? describeReadError('Full Reset', resetCreditsResult.reason) : null,
  ].filter((message): message is string => Boolean(message));

  const snapshot: CodexAccountUsageSnapshot = {
    source: 'chatgpt-wham',
    fetchedAt,
    account: {
      authenticated: true,
      email: usage.email,
      accountIdMasked: maskCodexAccountId(usage.accountId || authAccountId),
    },
    planType: usage.planType,
    rateLimitReachedType: usage.rateLimitReachedType,
    quotaGroups: usage.quotaGroups,
    billingCredits: usage.billingCredits,
    resetCredits,
    error: errors.length > 0 ? errors.join(' · ') : null,
  };
  accountUsageCache.set(cacheKey, { expiresAt: now() + ACCOUNT_USAGE_CACHE_TTL_MS, snapshot });
  return snapshot;
}

export interface CodexResetConsumptionResult {
  outcome: 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed';
  windowsReset: number;
}

export async function consumeCodexRateLimitResetCredit(
  profile: CodexAccountUsageProfile,
  options: {
    creditId: string;
    redeemRequestId: string;
    fetchImpl?: FetchLike;
  }
): Promise<CodexResetConsumptionResult> {
  const creditId = options.creditId.trim();
  const redeemRequestId = options.redeemRequestId.trim();
  if (!creditId || creditId.length > 512) {
    throw new Error('מזהה קרדיט Full Reset אינו תקין.');
  }
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(redeemRequestId)) {
    throw new Error('מזהה פעולת Full Reset אינו תקין.');
  }

  const fetchImpl = options.fetchImpl || (fetch as unknown as FetchLike);
  const currentUsage = await loadCodexAccountUsage(profile, {
    forceRefresh: true,
    fetchImpl,
  });
  const selectedCredit = currentUsage.resetCredits?.credits.find((credit) => credit.id === creditId);
  if (!selectedCredit || selectedCredit.status.toLowerCase() !== 'available') {
    throw new Error('קרדיט ה־Full Reset שנבחר כבר אינו זמין. רענן את הנתונים ונסה שוב.');
  }
  // Match Codex's redemption flow: an available credit can be submitted for
  // confirmation even when the usage summary reports zero applicable credits.
  // Only the consume response determines whether a window can actually reset.

  let auth: Record<string, unknown> | null = null;
  try {
    auth = asRecord(JSON.parse(await fs.readFile(path.join(profile.codexHome, 'auth.json'), 'utf8')));
  } catch {
    // Report the same safe authentication error for unreadable and malformed files.
  }
  const tokens = asRecord(auth?.tokens);
  const accessToken = readString(tokens?.access_token);
  const accountId = readString(tokens?.account_id);
  if (!accessToken || !accountId) {
    throw new Error('נדרשת התחברות ChatGPT פעילה כדי להפעיל Full Reset.');
  }

  const response = await fetchImpl(`${CHATGPT_RESET_CREDITS_URL}/consume`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-ID': accountId,
      'OpenAI-Beta': 'codex-1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      redeem_request_id: redeemRequestId,
      credit_id: creditId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`הפעלת Full Reset נכשלה (HTTP ${response.status}).`);
  }
  const payload = asRecord(await response.json());
  const outcome = readString(payload?.code);
  if (!['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(outcome || '')) {
    throw new Error('התקבלה תשובת Full Reset לא מוכרת.');
  }

  clearCodexAccountUsageCache(profile);
  return {
    outcome: outcome as CodexResetConsumptionResult['outcome'],
    windowsReset: readCount(payload?.windows_reset),
  };
}
