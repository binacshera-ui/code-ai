import { preserveRuntimeAuthentication } from '../runtime-auth.mjs';
await preserveRuntimeAuthentication();
if (process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES?.trim()) {
  throw new Error('Unqualified shared native ownership must remain disabled in this release.');
}
await import('./app.mjs');
