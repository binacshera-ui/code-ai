import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexDeviceAuthOutput } from './codexAccountAuth.js';

test('parses the official Codex device-auth prompt with ANSI formatting', () => {
  const parsed = parseCodexDeviceAuthOutput(`
Welcome to Codex
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[34mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code (expires in 15 minutes)
   \u001b[34mABCD-EFGH\u001b[0m
`);

  assert.deepEqual(parsed, {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
  });
});

test('waits for a complete prompt and never exposes a non-HTTPS external URL', () => {
  assert.deepEqual(parseCodexDeviceAuthOutput('Open https://auth.openai.com/codex/device'), {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: null,
  });
  assert.deepEqual(parseCodexDeviceAuthOutput('Open http://example.com/device and enter TEST-CODE'), {
    verificationUrl: null,
    userCode: 'TEST-CODE',
  });
});
