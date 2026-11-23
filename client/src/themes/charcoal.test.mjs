import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postcss from 'postcss';
const directory = path.dirname(fileURLToPath(import.meta.url));
const css = await fs.readFile(directory + '/charcoal.css', 'utf8');
const parsed = postcss.parse(css);
const root = parsed.nodes.find(node => node.type === 'rule' && node.selector === '.code-ai-theme-dark');
const tokens = Object.fromEntries(root.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]));

test('dark tokens follow the canonical Bina 3.0 neutral palette', () => {
  for (const [name, expected] of Object.entries({ 'canvas-bg': '#0a0a0a', 'panel-bg': '#171717', 'soft-strong-bg': '#262626',
    'panel-border': '#333333', 'canvas-text': '#ededed', 'text-faint': '#a3a3a3' })) assert.equal(tokens['--code-ai-' + name], expected);
  assert.equal(tokens['color-scheme'], 'dark');
  assert.ok(root.nodes.find(n => n.prop === 'background').important, 'root must beat historical slate utility');
});
test('theme rules are scoped to dark Code-AI, never the Bina shell, light mode or document/canvas assets', () => {
  parsed.walkRules(rule => { assert.ok(rule.selector.startsWith('.code-ai-theme-dark'), rule.selector); });
  assert.ok(!css.includes('.code-ai-theme-light') && !css.includes('canvas {') && !css.includes('img {'));
  assert.ok(!/#(?:020617|0f172a|1e293b|111827|334155)\b/i.test(css), 'navy palette must not survive in the new theme');
});
test('user bubbles, code, metadata, avatars and controls derive from the same dark tokens', () => {
  for (const name of ['bubble-bg', 'bubble-bg-strong', 'bubble-border', 'bubble-text', 'meta', 'meta-faint',
    'action-bg', 'action-bg-hover', 'action-text', 'inline-code-bg', 'inline-code-border', 'inline-code-text', 'avatar-bg', 'avatar-text'])
    assert.ok(tokens['--code-ai-user-' + name], name);
  assert.equal(tokens['--code-ai-user-bubble-text'], '#ededed');
  assert.ok(css.includes('caret-color: #ffffff'));
});
test('primary and secondary text maintain normal-text contrast on surfaces and hover states', () => {
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(s => parseInt(s, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const fg of ['#ededed', '#d4d4d4', '#b8b8b8', '#a3a3a3']) for (const bg of ['#0a0a0a', '#171717', '#262626', '#333333'])
    assert.ok((luminance(fg) + .05) / (luminance(bg) + .05) >= 4.5, fg + ' on ' + bg);
});
test('status colors stay distinguishable, backdrops stay translucent and keyboard focus is retained', () => {
  for (const color of ['#fde047', '#86efac', '#fca5a5']) assert.ok(css.includes(color));
  assert.ok(css.includes('rgb(0 0 0 / .6)'));
  assert.ok(css.includes(':focus-visible') && css.includes('outline-color: #a3a3a3'));
});
test('index imports one canonical dark stylesheet and no longer ships duplicate navy rules', async () => {
  const index = await fs.readFile(directory + '/../index.css', 'utf8');
  assert.equal(index.split('@import "./themes/charcoal.css" layer(components);').length, 2);
  assert.ok(!index.includes('.code-ai-theme-dark'));
  assert.ok(index.includes(".code-ai-theme-light[data-theme-preset='cream']"));
});
test('terminal canvas selects charcoal only in dark mode and retains ANSI semantic colors', async () => {
  const terminal = await fs.readFile(directory + '/../components/codex/CodexTerminalDialog.tsx', 'utf8');
  assert.ok(terminal.includes("hostRef.current.closest('.code-ai-theme-dark') ?"));
  assert.ok(terminal.includes("background: '#0a0a0a', foreground: '#ededed'"));
  assert.ok(terminal.includes("red: '#fb7185'") && terminal.includes("blue: '#93c5fd'"));
  assert.ok(terminal.includes("} : {})"));
});
