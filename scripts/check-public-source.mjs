import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean))];
const extraPolicy = process.env.CODE_AI_PRIVATE_IDENTIFIERS_FILE;
const identifiers = extraPolicy ? readFileSync(extraPolicy, 'utf8').split(/\r?\n/)
  .map(value => value.trim().toLowerCase()).filter(value => value && !value.startsWith('#')) : [];
const rules = [
  ['operator-home', /\/(?:root\/|mnt\/hdd\/|home\/(?!example(?:-secondary)?\/|you\/|ubuntu\/|operator\/)[^/\s'"`]+\/)/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['provider-key', /\b(?:AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}|rpr_(?!test_)[A-Za-z0-9_-]{24,})/g],
  ['personal-contact', /[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook|yahoo)\.[A-Za-z.]+/g],
  ['private-network', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3}\.)\d{1,3}\b/g],
  ['credential-default', /(?:devicePassword|sessionSecret):\s*process\.env\.[A-Z_]+\s*\|\|\s*['"][^'"\n]+['"]/g],
];
const findings = [];
let filesChecked = 0;
for (const file of files) {
  const absolute = path.join(root, file);
  let bytes;
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      findings.push({ file, rule: 'published-symlink' });
      continue;
    }
    bytes = readFileSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  if (/^(?:ops|\.private)\/|(?:^|\/)(?:MIGRATION-RECEIPT\.md|[^/]+\.bundle)$/.test(file)) {
    findings.push({ file, rule: 'private-source-path' });
    continue;
  }
  filesChecked += 1;
  if (bytes.subarray(0, 8000).includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ file, line: text.slice(0, match.index).split('\n').length, rule });
    }
  }
  // A repository's own public GitHub identity is not a private service identifier.
  const policyText = text.replace(/https:\/\/github\.com\/[^\s'"`)<]+/g, '').toLowerCase();
  if (identifiers.some(identifier => policyText.includes(identifier))) {
    findings.push({ file, rule: 'operator-private-identifier' });
  }
}
if (findings.length) {
  // Report locations only; never print matched credential or personal values.
  console.error(JSON.stringify({ publicSourceCheck: 'failed', findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ publicSourceCheck: 'passed', filesChecked }));
}
