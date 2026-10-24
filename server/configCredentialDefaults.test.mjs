import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
const source=await fs.readFile(new URL('./config.ts',import.meta.url),'utf8');
test('device authentication has no source-embedded credential fallback',()=>{
 assert.match(source,/deviceAdminPassword:\s*process\.env\.CODEX_DEVICE_ADMIN_PASSWORD\s*\|\|\s*''/);
});
test('session signing requires a configured secret, not a shared source constant',()=>{
 assert.match(source,/sessionSecret:\s*process\.env\.SESSION_SECRET\s*\|\|\s*''/);
});
