import { preserveRuntimeAuthentication } from '../runtime-auth.mjs';
import { readFile } from 'node:fs/promises';
await preserveRuntimeAuthentication();
if (process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES?.trim()) {
  const proof = JSON.parse(await readFile(new URL('../qualification/native-owner.json', import.meta.url), 'utf8'));
  if (proof.format !== 'code-ai-native-owner-qualified' || proof.version !== 1
      || proof.nativeProtocolQualified !== true || proof.guiLaunchQualified !== true
      || proof.modeTransportQualified !== true || proof.compiledApplication !== true) {
    throw new Error('Qualified shared native ownership is unavailable.');
  }
}
await import('./app.mjs');
