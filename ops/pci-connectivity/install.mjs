#!/usr/bin/env node
// Additive SSH wiring only. Never installs/restarts Code AI or reads its secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CENTRAL_ADDRESS = '162.55.2.222';
export const PCI_ADDRESS = '198.23.160.30';
export const LINK_USER = 'codeai-pci';
export const LINK_HOME = '/var/lib/code-ai-pci-link';
const MARKER = 'code-ai-pci-connectivity-v1';

export function mergeManagedBlock(previous, body, marker = MARKER) {
  const begin = `# BEGIN ${marker}`;
  const end = `# END ${marker}`;
  const block = `${begin}\n${body.trim()}\n${end}\n`;
  if (previous.includes(begin) || previous.includes(end)) {
    const first = previous.indexOf(begin);
    const last = previous.indexOf(end);
    if (first < 0 || last < first || previous.indexOf(begin, first + 1) >= 0 || previous.indexOf(end, last + 1) >= 0) {
      throw new Error('Ambiguous managed block; refusing to overwrite');
    }
    const existing = previous.slice(first, last + end.length).trim();
    if (existing !== block.trim()) throw new Error('Managed configuration changed; inspect before replacing');
    return previous;
  }
  // Include is deliberately first: user aliases after a catch-all still work.
  return block + (previous ? `\n${previous}` : '');
}

function privateWrite(filename, value, mode = 0o600) {
  const temporary = `${filename}.pci-${process.pid}`;
  fs.writeFileSync(temporary, value, { mode, flag: 'wx' });
  fs.renameSync(temporary, filename);
}

function addConfig(sshHome, controlIdentity, relayIdentity) {
  const config = path.join(sshHome, 'config');
  const old = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const include = path.join(sshHome, 'code-ai-connectivity.conf');
  if (/^\s*Host\s+.*\b(code-ai-control|personal-windows-ssh)\b/im.test(old)) {
    throw new Error('Existing peer alias must be inspected before adding configuration');
  }
  const peerConfig = `# PCI -> central Linux account (no sudo granted)\nHost code-ai-control code-ai-central\n  HostName ${CENTRAL_ADDRESS}\n  User ${LINK_USER}\n  IdentityFile ${controlIdentity}\n\n# PCI -> Windows user through a forced-command broker, never a root shell\nHost personal-windows-ssh code-ai-personal\n  HostName ${CENTRAL_ADDRESS}\n  User root\n  IdentityFile ${relayIdentity}\n  RequestTTY no\n\nHost code-ai-control code-ai-central personal-windows-ssh code-ai-personal\n  Port 22\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${path.join(sshHome, 'code-ai-central_known_hosts')}\n  ConnectTimeout 10\n  ServerAliveInterval 15\n  ServerAliveCountMax 3\n  ForwardAgent no\n`;
  if (fs.existsSync(include) && fs.readFileSync(include, 'utf8') !== peerConfig) {
    throw new Error('Conflicting peer file; refusing to overwrite');
  }
  if (!fs.existsSync(include)) privateWrite(include, peerConfig);
  const next = mergeManagedBlock(old, `Include ${include}`);
  if (next !== old) privateWrite(config, next);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  // Do not propagate arbitrary tool output or command args into exception text.
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? 'spawn'})`);
  return result.stdout;
}

function publicKey(value) {
  const key = String(value).trim().split(/\s+/).slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) throw new Error('Invalid public key');
  return key;
}

function addAuthorizedKey(home, line, comment, uid, gid) {
  const dir = path.join(home, '.ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chownSync(dir, uid, gid);
  const filename = path.join(dir, 'authorized_keys');
  const old = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
  const matches = old.split('\n').filter(item => item.endsWith(` ${comment}`));
  if (matches.length > 1 || (matches.length === 1 && matches[0] !== line)) {
    throw new Error('Conflicting key registration; refusing to replace existing access');
  }
  if (!matches.length) privateWrite(filename, `${old}${old && !old.endsWith('\n') ? '\n' : ''}${line}\n`);
  fs.chownSync(filename, uid, gid);
  fs.chmodSync(filename, 0o600);
}

export function installPeer(hostKey) {
  if (process.getuid() === 0) throw new Error('Peer keys must be created as the ordinary PCI user');
  const home = fs.realpathSync(os.homedir());
  const dir = path.join(home, '.ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPaths = ['code-ai-central_ed25519', 'code-ai-windows-relay_ed25519'].map(name => path.join(dir, name));
  for (const key of keyPaths) {
    if (!fs.existsSync(key)) run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', MARKER, '-f', key]);
    if (!fs.existsSync(`${key}.pub`)) throw new Error('Public half of existing key is missing');
    fs.chmodSync(key, 0o600);
  }
  const knownHosts = path.join(dir, 'code-ai-central_known_hosts');
  const expected = `${CENTRAL_ADDRESS} ${publicKey(hostKey)}\n`;
  if (fs.existsSync(knownHosts) && fs.readFileSync(knownHosts, 'utf8') !== expected) throw new Error('Pinned central host identity changed');
  if (!fs.existsSync(knownHosts)) privateWrite(knownHosts, expected);
  addConfig(dir, ...keyPaths);
  // Public keys are consumed privately by the coordinator, not logged to chat.
  return { user: os.userInfo().username, home, controlPublicKey: publicKey(fs.readFileSync(`${keyPaths[0]}.pub`, 'utf8')), relayPublicKey: publicKey(fs.readFileSync(`${keyPaths[1]}.pub`, 'utf8')) };
}

export function installCentral(peers, relayPath) {
  if (process.getuid() !== 0) throw new Error('Central key registration requires root');
  const known = spawnSync('/usr/bin/getent', ['passwd', LINK_USER], { encoding: 'utf8' });
  if (known.status !== 0) run('/usr/sbin/useradd', ['--create-home', '--home-dir', LINK_HOME, '--shell', '/bin/bash', LINK_USER]);
  const fields = run('/usr/bin/getent', ['passwd', LINK_USER]).trim().split(':');
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (uid === 0 || fields[5] !== LINK_HOME) throw new Error('Unexpected central account identity');
  for (const peer of peers) {
    if (!['admin', 'binapay-admin'].includes(peer.user)) throw new Error('Unexpected PCI peer');
    const controlComment = `code-ai-pci-control-${peer.user}`;
    const relayComment = `code-ai-pci-windows-relay-${peer.user}`;
    addAuthorizedKey(LINK_HOME, `from="${PCI_ADDRESS}",restrict,pty ${publicKey(peer.controlPublicKey)} ${controlComment}`, controlComment, uid, gid);
    addAuthorizedKey('/root', `from="${PCI_ADDRESS}",restrict,command="/usr/bin/node ${relayPath}" ${publicKey(peer.relayPublicKey)} ${relayComment}`, relayComment, 0, 0);
  }
  return { account: LINK_USER, sudoGranted: false, peers: peers.map(peer => peer.user), restartRequired: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = process.argv[2] === 'peer' ? installPeer(input.centralHostPublicKey)
      : process.argv[2] === 'central' ? installCentral(input.peers, input.relayPath)
        : (() => { throw new Error('Expected peer or central operation'); })();
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
