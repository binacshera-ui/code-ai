import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

test('manual saved API login preserves the home/history and requires logout before a different connection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manual-api-login-'));
  const home = path.join(root, '.codex'), privateRoot = path.join(root, 'private');
  await fs.mkdir(home); await fs.mkdir(privateRoot, { mode: 0o700 });
  const executable = path.join(root, 'synthetic-codex');
  await fs.writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const auth=path.join(process.env.CODEX_HOME,'auth.json');
if(process.argv[2]==='logout'){fs.rmSync(auth,{force:true});process.exit(0)}
if(process.argv[2]==='login'&&process.argv[3]==='--with-api-key'){
 let key='';process.stdin.on('data',chunk=>key+=chunk);process.stdin.on('end',()=>{
 fs.writeFileSync(auth,JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:key.trim()}),{mode:0o600});
 console.log('Successfully logged in');});
}else{process.exit(2)}
`, { mode: 0o700 });
  process.env.CODEX_BIN = executable;
  process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES = '';
  process.env.CODE_AI_OPENAI_CREDENTIALS_FILE = path.join(privateRoot, 'registry.json');
  const { saveCodexApiCredential, listCodexApiCredentials } = await import('./codexApiCredentials.js');
  const { loginCodexApiCredential, disconnectCodexAccount, startCodexDeviceAuth } = await import('./codexAccountAuth.js');
  const { readCodexAccountConnection } = await import('./codexAccountConnection.js');
  const profile = { id: 'synthetic-manual-api', codexHome: home };
  t.after(async () => { await disconnectCodexAccount(profile).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(home, 'sessions'));
  const history = path.join(home, 'sessions', 'existing.jsonl');
  await fs.writeFile(history, 'existing synthetic history\n');
  const a = await saveCodexApiCredential(profile, { label: 'Account A', apiKey: ('sk-' + 'synthetic-account-a-free-credit') });
  const b = await saveCodexApiCredential(profile, { label: 'Account B', apiKey: ('sk-' + 'synthetic-account-b-free-credit') });
  assert.equal((await readCodexAccountConnection(profile)).authenticated, false, 'saving does not log in');
  const connected = await loginCodexApiCredential(profile, a.id);
  assert.equal(connected.type, 'apiKey'); assert.equal(connected.credentialLabel, 'Account A');
  assert.equal((await readCodexAccountConnection(profile)).credentialId, a.id);
  await assert.rejects(loginCodexApiCredential(profile, b.id), /להתנתק/);
  await assert.rejects(startCodexDeviceAuth(profile), /להתנתק/);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, ('sk-' + 'synthetic-account-a-free-credit'));
  await disconnectCodexAccount(profile);
  assert.equal((await readCodexAccountConnection(profile)).authenticated, false);
  assert.equal((await listCodexApiCredentials(profile)).length, 2, 'logout keeps saved keys');
  await loginCodexApiCredential(profile, b.id);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, ('sk-' + 'synthetic-account-b-free-credit'));
  assert.equal(await fs.readFile(history, 'utf8'), 'existing synthetic history\n');
});
