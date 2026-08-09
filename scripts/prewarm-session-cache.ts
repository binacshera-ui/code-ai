import {
  getAvailableProfiles,
  getCodexSessionDetail,
  listCodexSessions,
} from '../server/codexService.js';

const requestedProfile = process.argv[2]?.trim() || '';
const requestedConcurrency = Number.parseInt(process.env.CODEX_SESSION_PREWARM_CONCURRENCY || '2', 10);
const concurrency = Number.isFinite(requestedConcurrency)
  ? Math.max(1, Math.min(8, requestedConcurrency))
  : 2;

async function prewarmProfile(profileId: string): Promise<{ warmed: number; failed: number }> {
  const sessions = await listCodexSessions(profileId, '', 10_000, true);
  let cursor = 0;
  let warmed = 0;
  let failed = 0;
  const startedAt = Date.now();

  async function worker(): Promise<void> {
    while (cursor < sessions.length) {
      const index = cursor;
      cursor += 1;
      const session = sessions[index];
      try {
        await getCodexSessionDetail(session.id, profileId, { tail: 120 });
        warmed += 1;
      } catch (error: any) {
        failed += 1;
        console.error(`[${profileId}] failed ${session.id}: ${error?.message || String(error)}`);
      }
      if ((warmed + failed) % 25 === 0 || warmed + failed === sessions.length) {
        const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
        console.log(JSON.stringify({
          profileId,
          processed: warmed + failed,
          total: sessions.length,
          warmed,
          failed,
          sessionsPerSecond: Number(((warmed + failed) / elapsedSeconds).toFixed(2)),
        }));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sessions.length || 1) }, () => worker()));
  return { warmed, failed };
}

const profiles = (await getAvailableProfiles())
  .filter((profile) => !requestedProfile || profile.id === requestedProfile);

if (requestedProfile && profiles.length === 0) {
  throw new Error(`Codex profile ${requestedProfile} is not available`);
}

let totalWarmed = 0;
let totalFailed = 0;
for (const profile of profiles) {
  const result = await prewarmProfile(profile.id);
  totalWarmed += result.warmed;
  totalFailed += result.failed;
}

console.log(JSON.stringify({
  complete: true,
  profiles: profiles.map((profile) => profile.id),
  warmed: totalWarmed,
  failed: totalFailed,
}));

if (totalWarmed === 0 && totalFailed > 0) {
  process.exitCode = 1;
}
