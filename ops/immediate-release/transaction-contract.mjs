import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function verifyQuestionResponse(response) {
  assert.ok([200, 400, 401, 403, 404].includes(response.status)
    && response.headers.get('content-type')?.includes('application/json'),
  'Native question endpoint returned an unexpected status or SPA fallback');
}

export async function verifyServedAssets({ origin, releaseRoot, fetch, readFile }) {
  const response = await fetch(origin + '/', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  const scripts = [...html.matchAll(/src="(\/assets\/[^"\s]+\.js)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const asset of scripts) {
    const received = await fetch(origin + asset, { signal: AbortSignal.timeout(5000) });
    assert.equal(received.status, 200);
    assert.equal(hash(Buffer.from(await received.arrayBuffer())),
      hash(await readFile(releaseRoot + '/dist/public' + asset)), 'Active release assets do not match');
  }
  return { servedAssetHashesMatched: true, assetsChecked: scripts.length };
}

// Restoration checks use the predecessor, never the failed candidate. Each
// service is recovered independently so a failed main health check cannot
// leave the unchanged passive upload service stopped. Errors are metadata only.
export async function recoverMainTransaction({ swapped, override, stopped, actions }) {
  const result = { errors: [] };
  const attempt = async (step, action) => {
    try { await action(); result[step] = true; return true; }
    catch (error) {
      result[step] = false;
      result.errors.push({ step, code: /^[A-Z_0-9]{1,40}$/.test(error.code || '') ? error.code : 'UNCLASSIFIED' });
      return false;
    }
  };
  const pointerRestored = !swapped || await attempt('pointerRestored', actions.restorePointer);
  const uploadOverrideRestored = !override || await attempt('uploadOverrideRestored', actions.restoreUploadOverride);
  if (stopped && pointerRestored) {
    const mainStarted = await attempt('mainStarted', actions.restartMain);
    if (mainStarted) {
      await attempt('mainReadinessVerified', actions.checkMainBaseline);
      await attempt('pm2Saved', actions.savePm2);
    }
  }
  if (stopped && uploadOverrideRestored) {
    const uploadsStarted = await attempt('uploadsStarted', actions.restartUploads);
    if (uploadsStarted) await attempt('uploadReadinessVerified', actions.checkUploads);
  }
  result.verified = result.errors.length === 0;
  return result;
}
