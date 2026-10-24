import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('chrome-extension/panelPairing.js', 'utf8');
const module = new vm.SourceTextModule(source, { context: vm.createContext({ URL }) });
await module.link(() => { throw new Error('Pairing helper must have no dependencies'); });
await module.evaluate();
const { normalizePairingCode, pairPanelInstallation } = module.namespace;

test('pairing accepts a generated code and rejects passwords or ambiguous characters', () => {
  assert.equal(normalizePairingCode('abcd efgh'), 'ABCD-EFGH');
  assert.equal(normalizePairingCode('ABCD-EFGH'), 'ABCD-EFGH');
  for (const code of ['', 'secret password', '1234-5678', '<script>', 'ABCD-EFGHZZ']) assert.throws(() => normalizePairingCode(code));
});
test('pairing uses only the existing authenticated-code claim contract', async () => {
  let sent;
  const response = await pairPanelInstallation({ controlOrigin: 'https://fixture.invalid', code: 'ABCD-EFGH' }, async value => {
    sent = value;
    return { ok: true, settings: { deviceId: 'synthetic-device' } };
  });
  assert.equal(sent.type, 'PAIR_DEVICE');
  assert.equal(sent.controlOrigin, 'https://fixture.invalid');
  assert.equal(sent.password, undefined);
  assert.equal(response.settings.deviceId, 'synthetic-device');
});
test('invalid origin and failed claim do not create trusted-device state', async () => {
  let sent = false;
  await assert.rejects(pairPanelInstallation({ controlOrigin: 'https://user:pass@fixture.invalid', code: 'ABCD-EFGH' }, async () => { sent=true; }));
  assert.equal(sent, false);
  await assert.rejects(pairPanelInstallation({ controlOrigin: 'https://fixture.invalid', code: 'ABCD-EFGH' }, async () => ({ ok:false, error:'Expired synthetic code' })), /Expired synthetic code/);
  await assert.rejects(pairPanelInstallation({ controlOrigin: 'https://fixture.invalid', code: 'ABCD-EFGH' }, async () => ({ ok:true, settings:{} })));
});
test('recovery controls have real HTML targets and no password input', async () => {
  const html = await fs.readFile('chrome-extension/panel.html', 'utf8');
  for (const id of ['pairing-drawer', 'pairing-form', 'pairing-code', 'pairing-submit']) assert.ok(html.includes(`id="${id}"`));
  assert.ok(!html.includes('type="password"'));
});
