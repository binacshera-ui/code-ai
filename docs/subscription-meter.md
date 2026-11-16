# Subscription quota measurement

## Foundation decision (2026-11-16)

Use the existing Codex canonical `token_usage_record.thread_token_usage` counters
(legacy `token_count` fallback), `turn_context` model
metadata, read-only native thread index, and account quota endpoint already used
by `server/codexAccountUsage.ts`. The representative live spike confirmed integer
weekly quota percentages and separate input/cache/output counters. No tokenizer,
model orchestration, pricing feed, or new native app-server owner is needed.

| Candidate | Retained / reason |
| --- | --- |
| Existing Codex counters and account usage adapter | Authoritative reported tokens/quota; selected foundation. |
| ccusage 20.0.51 (MIT, upstream docs inspected) | Useful historical/API-equivalent reports, fork and compaction handling. Not used as a minute-by-minute collector: full history scans and API rate cards do not identify subscription quota consumption. No upstream code copied. |
| New tokenizer or synthetic load generator | Rejected: redundant counting and unnecessary quota consumption while real workloads run. |

The narrow missing capability is incremental observation and conservative
subscription allocation. It uses Node's bundled SQLite, pinned by the deployed
Node runtime, and has no package installation or migration of application data.

## Contract

The sampler reads only existing local Codex files/databases and GETs the same
ChatGPT usage endpoint as Code AI. It never starts a model, refreshes credentials,
changes a conversation, or writes to a provider home. It has its own SQLite
database. The main Code AI process and native owner do not restart.

Run it with Node >=22.13 (the built-in `node:sqlite` module is required):

```sh
node scripts/codex-subscription-meter.mjs begin --config /private/config.json
node scripts/codex-subscription-meter.mjs collect --config /private/config.json
node scripts/codex-subscription-meter.mjs report --config /private/config.json
node --test scripts/subscription-meter/core.test.mjs
```

Configuration (private, not committed):

```json
{
  "profileId": "my-profile",
  "codexHome": "/absolute/provider/home",
  "stateDir": "/absolute/private/meter-state",
  "monthlyUsd": 500,
  "minimumQuotaDelta": 5,
  "minimumSegmentSeconds": 300,
  "billingStart": null,
  "billingEnd": null
}
```

Use one configuration per subscription; do not charge $500 to every profile.
Account identity is stored as a hash, never an email or credential. `begin`
creates a new measurement without erasing previous measurements. Schedule
`collect` every minute using the supplied systemd templates. Reports are written
atomically to `stateDir/report.json` and `stateDir/report.md`.

## Accounting and limitations

- Only positive cumulative differences after a per-thread baseline count.
  Repeated snapshots, inherited fork prefixes and file replay are not new usage.
  Truncation, counter decreases and oversize skipped rows are coverage gaps.
- Canonical records include compaction consumption that legacy token counters
  may omit. Keep separate baselines and never mix the two cumulative streams.
  A transition to canonical records is rebaselined and marked as a gap. Actual
  model reroutes update model attribution. Recently archived originals remain
  included; moving/replaying a file is not new consumption.
  Some CLI versions do not persist provider reroute notices: attribution is to
  the requested model unless a persisted reroute identifies the actual one.
- Cached input is a subset of input. Reasoning is a subset of output, not an
  additional billable category. Model/speed metadata comes from the event's
  context, never today's configuration retroactively. Unknown stays unknown.
- Initial discovery baselines existing files at EOF. Newly discovered threads
  can include only post-start, post-creation usage. The native index is read
  read-only; no recursive scans of all conversation history every minute.
- Quota observations belong to an account, plan and reset epoch. Resets,
  account changes, plan changes, saturation at 100%, telemetry gaps and mixed
  model/speed segments cannot calibrate a single model.
- A single-model segment needs at least five percentage points and five minutes.
  Its blended estimate has a conservative +/-2-point rounding envelope, under
  the explicit assumption of at most one point of error per observation.
  This is not a confidence interval and does not cover delayed provider
  reporting or usage on other devices. External use is always unverified.
- Separate input/cache/output prices are not identifiable from one blended
  ratio. Report their observed counts separately. Do not claim a universal
  per-input or per-output price, fit mixed models by arbitrary proportions,
  interpolate official fractional quota, or report missing usage as zero.
- Allocation is `monthlyUsd * 7 / billingCycleDays`, if supplied; otherwise
  `monthlyUsd * 12 * 7 / 365.2425` (annualized average). At $500 this is about
  $114.99/week and $1.15 per weekly percentage point. It assumes the whole fee
  is allocated to this one weekly quota. It is neither an API rate nor an
  additional cash charge. Unused subscription capacity and other plan benefits
  are not priced independently. Parallel quota pools must not be summed.
- No historical backfill or synthetic model test is silently performed.
  Future controlled experiments need an explicit quota budget and isolation
  from concurrent/external activity; the ordinary sampler costs no model quota.

Official references: [account and token usage](https://learn.chatgpt.com/docs/app-server),
[subscription limits](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan).
