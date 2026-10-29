import assert from 'node:assert/strict';
import test from 'node:test';
import { accountAuthenticationPresentation, supportsCodexApiLogin, type CodexAccountConnection } from './accountAuthenticationPresentation.js';

const apiConnection: CodexAccountConnection = {
  authenticated: true,
  type: 'apiKey',
  credentialId: 'saved-organization-b',
  credentialLabel: 'Organization B',
  configured: true,
};

test('a legacy auth response keeps API login unavailable', () => {
  assert.equal(supportsCodexApiLogin({ auth: { state: 'idle' } }), false);
});

test('a new auth response advertises API support independently of connection state', () => {
  assert.equal(supportsCodexApiLogin({ auth: { state: 'idle' }, connection: null }), true);
  assert.equal(supportsCodexApiLogin({ auth: { state: 'idle' }, connection: apiConnection }), true);
});

test('only an own connection field advertises API support', () => {
  assert.equal(supportsCodexApiLogin(Object.create({ connection: apiConnection })), false);
  assert.equal(supportsCodexApiLogin(null), false);
  assert.equal(supportsCodexApiLogin(undefined), false);
});

test('API login is connected without ChatGPT quota credentials', () => {
  const result = accountAuthenticationPresentation({ authenticated: false }, apiConnection, 'Codex');
  assert.equal(result.authenticated, true);
  assert.equal(result.type, 'apiKey');
  assert.equal(result.label, 'Organization B');
  assert.equal(result.showChatgptUsage, false);
});

test('native API state hides stale ChatGPT identity and quota controls', () => {
  const result = accountAuthenticationPresentation({
    authenticated: true,
    type: 'chatgpt',
    email: 'former-account@example.test',
    accountIdMasked: 'old-account',
  }, apiConnection, 'Codex');
  assert.equal(result.label, 'Organization B');
  assert.equal(result.isApiKey, true);
  assert.equal(result.showChatgptUsage, false);
});

test('an API snapshot stays recognizable while native status loads', () => {
  const result = accountAuthenticationPresentation({
    authenticated: true,
    type: 'apiKey',
    credentialLabel: 'Saved API account',
  }, null, 'Codex');
  assert.equal(result.authenticated, true);
  assert.equal(result.label, 'Saved API account');
  assert.equal(result.showChatgptUsage, false);
});

test('manual native logout overrides an older authenticated usage snapshot', () => {
  const result = accountAuthenticationPresentation({
    authenticated: true,
    type: 'apiKey',
    credentialLabel: 'Old key',
  }, { ...apiConnection, authenticated: false, type: null, credentialId: null, credentialLabel: null, configured: false }, 'Codex');
  assert.equal(result.authenticated, false);
  assert.equal(result.type, null);
  assert.equal(result.label, 'לא מחובר');
});

test('existing ChatGPT accounts preserve identity and quota availability', () => {
  const result = accountAuthenticationPresentation({
    authenticated: true,
    email: 'current-account@example.test',
  }, null, 'Codex');
  assert.equal(result.authenticated, true);
  assert.equal(result.label, 'current-account@example.test');
  assert.equal(result.showChatgptUsage, true);
});

test('API connection without saved metadata never reuses ChatGPT identity', () => {
  const result = accountAuthenticationPresentation({
    authenticated: true,
    email: 'former-account@example.test',
  }, { ...apiConnection, credentialLabel: null }, 'Codex');
  assert.equal(result.label, 'מפתח API');
  assert.equal(result.showChatgptUsage, false);
});
