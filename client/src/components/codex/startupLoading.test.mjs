import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
test('initial account load does not wait for all remote hosts',async()=>{
 const source=await fs.readFile(new URL('./CodexMobileApp.tsx',import.meta.url),'utf8');
 const bootstrap=source.split('async function loadServersAndProfiles() {')[1].split('async function loadProfiles(')[0];
 assert.ok(bootstrap.includes('await loadServers(false)'));
 assert.ok(bootstrap.indexOf('await loadProfiles(')<bootstrap.indexOf('void loadServers(true)'));
 assert.ok(!bootstrap.includes('await loadServers(true)'));
 assert.ok(bootstrap.includes('servers-background-refresh-failed'));
});
