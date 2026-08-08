import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERSONAL_CHROME_PROTOCOL_VERSION,
  PERSONAL_CHROME_TOOLS,
  findPersonalChromeTool,
  shouldRequirePersonalChromeApproval,
  validatePersonalChromeToolArguments,
} from './personalChromeProtocol.js';

test('personal Chrome protocol exposes one typed definition per tool', () => {
  assert.equal(PERSONAL_CHROME_PROTOCOL_VERSION, 1);
  assert.equal(PERSONAL_CHROME_TOOLS.length, 19);
  const names = PERSONAL_CHROME_TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.slice(-3), ['dev_port_list', 'dev_port_open', 'dev_port_close']);
  for (const tool of PERSONAL_CHROME_TOOLS) {
    assert.equal(findPersonalChromeTool(tool.name)?.name, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 12);
  }
  assert.equal(findPersonalChromeTool('not_a_tool'), null);
});

test('tool argument validation rejects unknown, malformed, and out-of-range fields', () => {
  const navigate = findPersonalChromeTool('browser_navigate');
  const key = findPersonalChromeTool('browser_key');
  const port = findPersonalChromeTool('dev_port_open');
  assert.ok(navigate && key && port);
  assert.equal(validatePersonalChromeToolArguments(navigate, { url: 'https://example.com' }), null);
  assert.match(validatePersonalChromeToolArguments(navigate, {}) || '', /url is required/);
  assert.match(validatePersonalChromeToolArguments(navigate, { url: 'https://example.com', surprise: true }) || '', /surprise is not supported/);
  assert.match(validatePersonalChromeToolArguments(key, { key: 'Enter', repeat: 21 }) || '', /at most 20/);
  assert.match(validatePersonalChromeToolArguments(port, { sourceServerId: 'local', sourcePort: 70000 }) || '', /at most 65535/);
});

test('approval policy protects consequential and sensitive reads', () => {
  const click = findPersonalChromeTool('browser_click');
  const type = findPersonalChromeTool('browser_type');
  const key = findPersonalChromeTool('browser_key');
  const network = findPersonalChromeTool('browser_network');
  const snapshot = findPersonalChromeTool('browser_snapshot');
  const port = findPersonalChromeTool('dev_port_open');
  assert.ok(click && type && key && network && snapshot && port);

  assert.equal(shouldRequirePersonalChromeApproval(click, 'risky', {}), false);
  assert.equal(shouldRequirePersonalChromeApproval(click, 'risky', { sensitive: true }), true);
  assert.equal(shouldRequirePersonalChromeApproval(type, 'risky', { submit: true }), true);
  assert.equal(shouldRequirePersonalChromeApproval(key, 'risky', { sensitive: true }), true);
  assert.equal(shouldRequirePersonalChromeApproval(network, 'risky', { includeBodies: true }), true);
  assert.equal(shouldRequirePersonalChromeApproval(snapshot, 'always', {}), false);
  assert.equal(shouldRequirePersonalChromeApproval(port, 'risky', {}), true);
  assert.equal(shouldRequirePersonalChromeApproval(port, 'never', {}), false);
});

test('free-access policy auto-approves every exposed Chrome operation', () => {
  for (const tool of PERSONAL_CHROME_TOOLS) {
    const sensitiveArguments = tool.name === 'browser_network'
      ? { includeBodies: true }
      : tool.name === 'browser_type'
        ? { submit: true, secret: true }
        : tool.name === 'browser_key'
          ? { key: 'Enter', sensitive: true }
          : { sensitive: true };
    assert.equal(
      shouldRequirePersonalChromeApproval(tool, 'never', sensitiveArguments),
      false,
      `${tool.name} unexpectedly requested approval in free-access mode`,
    );
  }
});
