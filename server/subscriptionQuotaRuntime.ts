import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODEX_APP_CONFIG } from './config.js';
import { registerSubscriptionQuotaStopListener } from './subscriptionQuotaStop.js';
import { subscriptionTransportBlocked } from './subscriptionQuotaFence.mjs';
import { stopNativeSubscriptionTurns } from './subscriptionQuotaNativeStop.mjs';

let registered = false;
export function registerSubscriptionQuotaNativeStop() {
  if (registered) return;
  registered = true;
  const stateFile = process.env.CODE_AI_QUOTA_STOP_STATE_FILE
    || path.join(CODEX_APP_CONFIG.storageRoot, 'subscription-quota-stop.json');
  registerSubscriptionQuotaStopListener(async event => {
    const visited = new Set<string>();
    for (const profile of CODEX_APP_CONFIG.profiles) {
      if (profile.provider !== 'codex' || profile.mode !== 'standard'
          || !event.profileIds.includes(profile.id) || visited.has(profile.codexHome)) continue;
      visited.add(profile.codexHome);
      const isBlocked = async () => {
        try {
          const auth = JSON.parse(await fs.readFile(path.join(profile.codexHome, 'auth.json'), 'utf8'));
          if (['apikey', 'api_key', 'api-key'].includes(String(auth.auth_mode || '').toLowerCase())) return false;
          return subscriptionTransportBlocked(stateFile, auth.tokens?.account_id || null, null);
        } catch { return true; }
      };
      const report = await stopNativeSubscriptionTurns(profile, { isBlocked });
      // Counters only: never expose prompts, credentials, paths or account IDs.
      if (report.attemptedTurns.length || report.errors.length) console.info('[quota-stop]', {
        attempted: report.attemptedTurns.length, confirmed: report.confirmedTurns.length,
        pending: report.pendingTurns.length, ownerAvailable: report.ownerConnected,
      });
    }
  });
}
