import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubscriptionQuotaStopSnapshot } from '../../../../shared/subscriptionQuotaStop';
import { SubscriptionQuotaStopControl, SubscriptionQuotaStopView, type SubscriptionQuotaStopViewProps } from './SubscriptionQuotaStopControl';
import { formatQuotaStopPercent, quotaResetCountdown, subscriptionQuotaStopDraft, subscriptionQuotaStopSettings, subscriptionQuotaStopSavePayload, subscriptionQuotaStopStateLabel } from './subscriptionQuotaStopClient';

const snapshot: SubscriptionQuotaStopSnapshot = {
  supported: true, enabled: false, stopAtUsedPercent: 90, window: 'secondary', state: 'disabled',
  usedPercent: 47.25, remainingUntilStopPercent: 42.75, resetsAt: 1_800_000_000,
  observedAt: '2026-11-24T12:00:00Z', stoppedAt: null, message: null,
};
const noop = () => {};
function view(patch: Partial<SubscriptionQuotaStopViewProps> = {}) {
  return renderToStaticMarkup(<SubscriptionQuotaStopView snapshot={snapshot} draft={subscriptionQuotaStopDraft(snapshot)} nowMs={(snapshot.resetsAt! - 3_661) * 1_000} loading={false} saving={false} error={null} onChange={noop} onSave={noop} onRefresh={noop} onClose={noop} {...patch} />);
}

test('quota stop opens as an explicit save-only subscription draft, initially disabled', () => {
  const html = view();
  for (const text of ['role="switch"', 'aria-checked="false"', 'min="0.1"', 'max="100"', 'step="0.01"', 'value="90"', 'אחוז ניצול', 'לא אחוז שנותר', 'כל השיחות', 'אותו חשבון', 'תורים והפעלות מתוזמנות', 'שימוש במפתח API נשאר נפרד', 'שינויים נכנסים לתוקף רק אחרי שמירה', 'שמור סף עצירה']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('<option value="secondary" selected="">'));
  assert.ok(!html.includes('type="submit"'));
});

test('view distinguishes measured headroom and real provider reset from an invented time-to-threshold', () => {
  const html = view();
  for (const text of ['47.25%', '42.75%', '01:01:01', 'איפוס המכסה לפי הספק']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('דיווח מאוחר') && html.includes('חריגה קטנה מהסף'));
  assert.ok(!html.includes('עד העצירה:') && !html.includes('זמן עד העצירה'));
});

test('missing measurements remain unknown and do not display a fabricated countdown or zero usage', () => {
  const html = view({ snapshot: { ...snapshot, state: 'unavailable', usedPercent: null, remainingUntilStopPercent: null, resetsAt: null } });
  assert.equal((html.match(/לא ידוע/g) || []).length, 2);
  assert.ok(html.includes('אין כרגע מדידת מכסה עדכנית'));
  assert.ok(!html.includes('איפוס המכסה לפי הספק') && !html.includes('00:00:00') && !html.includes('>0%<'));
});

test('blocked status and backend messages are truthful text; unavailable connections cannot enable it', () => {
  const blocked = view({ snapshot: { ...snapshot, enabled: true, state: 'blocked', message: '<script>not trusted</script>' } });
  assert.ok(blocked.includes('סף העצירה הושג · השיחות חסומות'));
  assert.ok(blocked.includes('&lt;script&gt;') && !blocked.includes('<script>'));
  const unsupported = view({ snapshot: { ...snapshot, supported: false, state: 'unsupported' } });
  assert.ok(unsupported.includes('מפתח API או במסלול תשלום אחר'));
  assert.ok(!unsupported.includes('role="switch"') && !unsupported.includes('type="number"'));
  assert.match(unsupported, /disabled=""[^>]*>שמור סף עצירה/);
});

test('loading and saving disable controls and preserve explicit retry and accessible form labels', () => {
  const loading = view({ snapshot: null, loading: true });
  assert.ok(loading.includes('טוען את סף העצירה'));
  assert.ok(loading.includes('aria-label="רענן מדידת מכסה"'));
  assert.match(loading, /type="number"[^>]*disabled=""/);
  const saving = view({ saving: true });
  assert.match(saving, /disabled=""[^>]*>שומר…/);
  assert.ok(saving.includes('<label for=') && saving.includes('aria-describedby='));
});

test('the stopwatch launcher uses no render-time network request and no enabled default', () => {
  let calls = 0;
  const html = renderToStaticMarkup(<SubscriptionQuotaStopControl serverId="remote-test" profileId="synthetic-profile" themeClassName="code-ai-theme-dark" themePresetId="charcoal" load={async () => { calls++; return snapshot; }} save={async () => { calls++; return snapshot; }} />);
  assert.equal(calls, 0);
  assert.ok(html.includes('data-testid="subscription-quota-stop-launcher"') && html.includes('aria-label="סף עצירה למנוי"'));
  assert.ok(html.includes('data-quota-stop-state="loading"'));
  assert.ok(!html.includes('data-quota-stop-state="armed"') && !html.includes('90% ניצול'));
});

test('draft validation accepts fractional used percentages but rejects incomplete or out-of-range input', () => {
  assert.deepEqual(subscriptionQuotaStopSettings({ enabled: true, stopAtUsedPercent: '79.25', window: 'any' }), { enabled: true, stopAtUsedPercent: 79.25, window: 'any' });
  for (const value of ['', ' ', 'NaN', '-1', '0', '100.1', 'Infinity']) assert.throws(() => subscriptionQuotaStopSettings({ enabled: true, stopAtUsedPercent: value, window: 'secondary' }));
  assert.equal(subscriptionQuotaStopSettings(subscriptionQuotaStopDraft(snapshot)).enabled, false);
  assert.equal(formatQuotaStopPercent(null), 'לא ידוע');
  assert.equal(formatQuotaStopPercent(Number.NaN), 'לא ידוע');
});

test('reset countdown uses epoch seconds, days, and pending confirmation rather than auto-unblocking', () => {
  assert.equal(quotaResetCountdown(null, 0), null);
  assert.equal(quotaResetCountdown(Number.NaN, 0), null);
  assert.equal(quotaResetCountdown(90_061, 0), 'יום אחד · 01:01:01');
  assert.equal(quotaResetCountdown(100, 100_000), 'מועד האיפוס הגיע · ממתין לנתוני הספק');
  assert.equal(subscriptionQuotaStopStateLabel({ ...snapshot, state: 'blocked' }), 'סף העצירה הושג · השיחות חסומות');
});

test('save payload retains the account bound when the draft opened instead of a newer account snapshot', () => {
  const original = { ...snapshot, accountScope: 'original-account-scope' };
  const draft = subscriptionQuotaStopDraft(original);
  const latestPoll = { ...snapshot, accountScope: 'replacement-account-scope', stopAtUsedPercent: 50 };
  assert.equal(subscriptionQuotaStopSavePayload(draft, original.accountScope).accountScope, 'original-account-scope');
  assert.equal(subscriptionQuotaStopSavePayload(draft, original.accountScope).stopAtUsedPercent, 90);
  assert.notEqual(subscriptionQuotaStopSavePayload(draft, original.accountScope).accountScope, latestPoll.accountScope);
  assert.equal(subscriptionQuotaStopSavePayload(draft, null).accountScope, null);
});

test('an account conflict keeps the error and prevents saving until explicit refresh', () => {
  const html = view({ refreshRequired: true, error: 'חשבון המנוי השתנה מאז פתיחת ההגדרה.' });
  assert.ok(html.includes('חשבון המנוי השתנה') && html.includes('אין ניסיון חוזר אוטומטי'));
  assert.match(html, /disabled=""[^>]*>שמור סף עצירה/);
  assert.ok(html.includes('הרענון יטען טיוטה חדשה'));
});
