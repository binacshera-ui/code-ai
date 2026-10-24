import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const SOURCE = Object.freeze({
  computer: 'ME', user: 'showp', root: 'C:/Users/showp/.codex',
  alias: 'personal-windows-new-ssh', config: '/root/.ssh/personal-windows-new_config',
  id: 'windows-ME-20261008',
});
export const ROOT = '/mnt/hdd/code-ai-windows-backup/ME-20261008';
const PASSWORD = '/var/lib/code-ai-windows-backup/ME-20261008/password';
const RESTIC = '/usr/local/bin/restic';

function fail(code) { throw new Error(code); }
export function allowedPath(value) {
  return typeof value === 'string' && (
    /^(sessions|archived_sessions)\/(?:[0-9]{4}\/)?(?:[0-9]{2}\/){0,2}rollout-[A-Za-z0-9.-]+\.jsonl$/.test(value)
    || /^(history|session_index)\.jsonl$/.test(value)
  );
}
export function validateInventory(data) {
  if (data?.computer?.toUpperCase() !== SOURCE.computer || data.user !== SOURCE.user
    || data.root !== SOURCE.root) fail('SOURCE_IDENTITY_MISMATCH');
  if (!Array.isArray(data.files) || !data.files.length) fail('EMPTY_INVENTORY');
  const seen = new Set();
  for (const file of data.files) {
    if (!allowedPath(file.path) || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('INVALID_INVENTORY');
    seen.add(file.path);
  }
  if (!data.files.some(f => /^(sessions|archived_sessions)\//.test(f.path))) fail('NO_CONVERSATIONS');
  return data;
}
const psPrelude = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;`
  + `if($env:COMPUTERNAME -ne 'ME' -or $env:USERNAME -ne 'showp'){exit 41};`;
const inventoryPs = psPrelude + String.raw`
$root='C:/Users/showp/.codex';$items=@();
if((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){exit 42};
function Walk($dir){
  foreach($f in Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop){
    if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){continue};
    if($f.PSIsContainer){Walk $f.FullName}
    elseif($f.Extension -eq '.jsonl'){
      $normal=$f.FullName.Replace([char]92,[char]47);while($normal.Contains('//')){$normal=$normal.Replace('//','/')};
      $script:items+=[pscustomobject]@{path=$normal.Substring($root.Length+1);bytes=$f.Length;mtime=$f.LastWriteTimeUtc.ToString('o')}
    }
  }
};
foreach($part in @('sessions','archived_sessions')){$p=Join-Path $root $part;if(Test-Path -LiteralPath $p){if((Get-Item $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){exit 42};Walk $p}};
foreach($name in @('history.jsonl','session_index.jsonl')){$p=Join-Path $root $name;if(Test-Path -LiteralPath $p){$f=Get-Item $p -Force;if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 42};$items+=[pscustomobject]@{path=$name;bytes=$f.Length;mtime=$f.LastWriteTimeUtc.ToString('o')}}};
[pscustomobject]@{computer=$env:COMPUTERNAME;user=$env:USERNAME;root=$root;files=@($items)}|ConvertTo-Json -Depth 5 -Compress
`;
function sshArgs(ps) {
  return ['-F', SOURCE.config, '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    SOURCE.alias, 'powershell.exe -NoProfile -NonInteractive -EncodedCommand '
      + Buffer.from(ps, 'utf16le').toString('base64')];
}
export async function inventory() {
  let result;
  try { result = await exec('/usr/bin/ssh', sshArgs(inventoryPs), { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }); }
  catch { fail('SOURCE_OFFLINE_OR_INVENTORY_FAILED'); }
  try { return validateInventory(JSON.parse(result.stdout.replace(/^\uFEFF/, ''))); }
  catch (error) { if (/^[A-Z_]+$/.test(error.message)) throw error; fail('INVALID_INVENTORY_RESPONSE'); }
}
export async function download(relative, destination) {
  if (!allowedPath(relative)) fail('INVALID_DOWNLOAD_PATH');
  // Read a fixed prefix with FILE_SHARE_READ|WRITE. No writes or temporary files on Windows.
  const ps = psPrelude + `$root='C:/Users/showp/.codex';$relative='${relative}';` + String.raw`
$p=[IO.Path]::GetFullPath((Join-Path $root $relative));$scan=$p;
while($scan){$d=Get-Item -LiteralPath $scan -Force;if($d.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 42};$scan=Split-Path -Parent $scan};
$s=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);
try{
 $length=$s.Length;$out=[Console]::OpenStandardOutput();
 $header=[Text.Encoding]::UTF8.GetBytes((@{bytes=$length}|ConvertTo-Json -Compress)+[char]10);$out.Write($header,0,$header.Length);
 $buffer=New-Object byte[] 1048576;$left=$length;
 while($left -gt 0){$n=$s.Read($buffer,0,[int][Math]::Min($buffer.Length,$left));if($n -le 0){exit 43};$out.Write($buffer,0,$n);$left-=$n};$out.Flush()
}finally{$s.Dispose()}
`;
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await fs.open(destination, 'wx', 0o600);
  const child = spawn('/usr/bin/ssh', sshArgs(ps), { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume(); // Never log remote output: exceptions can embed input data.
  const completion = new Promise(resolve => {
    child.once('error', () => resolve(-1));
    child.once('close', code => resolve(code));
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 600000);
  let header = Buffer.alloc(0), expected = null, bytes = 0;
  try {
    for await (const chunk of child.stdout) {
      let body = chunk;
      if (expected === null) {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf(10);
        if (end < 0) { if (header.length > 4096) fail('INVALID_STREAM_HEADER'); continue; }
        if (end > 4096) fail('INVALID_STREAM_HEADER');
        let data; try { data = JSON.parse(header.subarray(0, end).toString()); } catch { fail('INVALID_STREAM_HEADER'); }
        if (!Number.isSafeInteger(data.bytes) || data.bytes < 0) fail('INVALID_STREAM_LENGTH');
        expected = data.bytes; body = header.subarray(end + 1); header = null;
      }
      bytes += body.length;
      if (bytes > expected) fail('STREAM_LENGTH_MISMATCH');
      let offset = 0;
      while (offset < body.length) offset += (await handle.write(body, offset, body.length - offset)).bytesWritten;
    }
    if (await completion !== 0 || expected === null || bytes !== expected) fail('DOWNLOAD_INCOMPLETE');
    await handle.sync();
    return bytes;
  } finally { clearTimeout(timeout); child.kill('SIGTERM'); await handle.close(); }
}
export async function inspectJsonl(file) {
  const hash = crypto.createHash('sha256');
  let pending = Buffer.alloc(0), records = 0, bytes = 0, trailingPartialBytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk); bytes += chunk.length;
    pending = Buffer.concat([pending, chunk]);
    let start = 0, end;
    while ((end = pending.indexOf(10, start)) >= 0) {
      const line = pending.subarray(start, end).toString('utf8').replace(/^\uFEFF/, '').trim();
      if (line) { try { JSON.parse(line); } catch { fail('INVALID_COMPLETE_JSONL_RECORD'); } records++; }
      start = end + 1;
    }
    pending = pending.subarray(start);
    if (pending.length > 64 * 1024 * 1024) fail('JSONL_RECORD_TOO_LARGE');
  }
  if (pending.length) {
    try { JSON.parse(pending.toString('utf8').replace(/^\uFEFF/, '')); records++; }
    catch { trailingPartialBytes = pending.length; }
  }
  return { bytes, sha256: hash.digest('hex'), records, trailingPartialBytes };
}
async function jsonWrite(file, value) {
  const temp = file + '.new';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function restic(args, cwd = ROOT) {
  try {
    const { stdout } = await exec(RESTIC, ['--json', '--repo', path.join(ROOT, 'repository'),
      '--password-file', PASSWORD, '--cache-dir', path.join(ROOT, 'cache'), ...args],
    { cwd, timeout: 600000, maxBuffer: 32 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
    return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { fail('RESTIC_' + args[0].toUpperCase().replace(/[^A-Z]/g, '') + '_FAILED'); }
}
async function freeSpaceGate() {
  const stat = await fs.statfs(ROOT);
  if (stat.bavail * stat.bsize < Math.max(100 * 1024 ** 3, stat.blocks * stat.bsize * .15)) fail('LOW_BACKUP_DISK_SPACE');
}
export async function verifyRestore(id) {
  if (!/^[a-f0-9]{8,64}$/.test(id)) fail('INVALID_SNAPSHOT_ID');
  const rows = await restic(['ls', id]);
  const manifests = rows.filter(x => x.type === 'file' && x.path?.endsWith('/capture-manifest.json'));
  if (manifests.length !== 1) fail('MANIFEST_NOT_UNIQUE');
  const snapshotDir = path.posix.dirname(manifests[0].path);
  if (snapshotDir.split('/').includes('..')) fail('INVALID_RESTORE_PATH');
  const target = await fs.mkdtemp(path.join(ROOT, 'restore-test-'));
  await fs.chmod(target, 0o700);
  await restic(['restore', id, '--target', target, '--verify']);
  const restored = path.join(target, snapshotDir.replace(/^\//, ''));
  const manifest = JSON.parse(await fs.readFile(path.join(restored, 'capture-manifest.json'), 'utf8'));
  if (manifest.sourceId !== SOURCE.id) fail('RESTORE_SOURCE_MISMATCH');
  for (const file of manifest.files) {
    if (!allowedPath(file.path)) fail('INVALID_RESTORE_MANIFEST');
    const proof = await inspectJsonl(path.join(restored, file.path));
    for (const key of ['sha256', 'bytes', 'records', 'trailingPartialBytes']) {
      if (proof[key] !== file[key]) fail('RESTORE_CONTENT_MISMATCH');
    }
  }
  const result = { verifiedAt: new Date().toISOString(), snapshotId: id, files: manifest.files.length,
    records: manifest.files.reduce((n, f) => n + f.records, 0), sourceId: SOURCE.id };
  await jsonWrite(path.join(ROOT, 'restore-verification.json'), result);
  // Only this successful, generated verification copy is removed. Repository is untouched.
  await fs.rm(target, { recursive: true });
  return result;
}
async function backup() {
  await freeSpaceGate();
  const listed = await inventory();
  const stage = await fs.mkdtemp(path.join(ROOT, 'capture-'));
  await fs.chmod(stage, 0o700);
  const files = [];
  try {
    for (const file of listed.files.sort((a, b) => a.path.localeCompare(b.path))) {
      const destination = path.join(stage, file.path);
      await download(file.path, destination);
      const proof = await inspectJsonl(destination);
      if (proof.bytes < file.bytes) fail('SOURCE_SHRANK_DURING_CAPTURE');
      if (!proof.records && /^(sessions|archived_sessions)\//.test(file.path)) fail('EMPTY_TRANSCRIPT');
      files.push({ path: file.path, ...proof });
    }
    const capturedAt = new Date().toISOString();
    await jsonWrite(path.join(stage, 'capture-manifest.json'), { version: 1, sourceId: SOURCE.id,
      sourceRoot: SOURCE.root, capturedAt, consistency: 'per-file-fixed-prefix; active unfinished final records retained', files });
    const result = await restic(['backup', '--host', SOURCE.id, '--tag', SOURCE.id,
      '--group-by', 'host,tags', '--ignore-inode', '.'], stage);
    const summary = result.find(x => x.message_type === 'summary');
    if (!summary?.snapshot_id) fail('NO_SNAPSHOT_ID');
    const receipt = { status: 'ok', sourceId: SOURCE.id, capturedAt, snapshotId: summary.snapshot_id,
      files: files.length, conversations: files.filter(x => /^(sessions|archived_sessions)\//.test(x.path)).length,
      bytes: files.reduce((n, f) => n + f.bytes, 0), records: files.reduce((n, f) => n + f.records, 0),
      partialFinalRecords: files.filter(f => f.trailingPartialBytes > 0).length };
    await jsonWrite(path.join(ROOT, 'last-success.json'), receipt);
    await jsonWrite(path.join(ROOT, 'last-attempt.json'), receipt);
    // Captured files are now in the encrypted, immutable snapshot. Never prune snapshots here.
    await fs.rm(stage, { recursive: true });
    return receipt;
  } catch (error) {
    // No completed snapshot: preserve this private capture for investigation/retry.
    throw error;
  }
}
async function main() {
  process.umask(0o077);
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  if (process.argv[2] === 'init') {
    await fs.mkdir(path.dirname(PASSWORD), { recursive: true, mode: 0o700 });
    const existingRepository = await fs.access(path.join(ROOT, 'repository/config')).then(() => true, () => false);
    if (existingRepository) {
      try { await fs.access(PASSWORD); } catch { fail('EXISTING_REPOSITORY_PASSWORD_MISSING'); }
    }
    try { await fs.writeFile(PASSWORD, crypto.randomBytes(48).toString('base64') + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await freeSpaceGate();
    if (!existingRepository) await restic(['init']);
    console.log(JSON.stringify({ status: 'initialized', sourceId: SOURCE.id }));
  } else if (process.argv[2] === 'verify') {
    const receipt = JSON.parse(await fs.readFile(path.join(ROOT, 'last-success.json'), 'utf8'));
    console.log(JSON.stringify(await verifyRestore(receipt.snapshotId)));
  } else if (process.argv[2] === 'backup') {
    console.log(JSON.stringify(await backup()));
  } else fail('EXPECTED_INIT_BACKUP_OR_VERIFY');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(async error => {
    const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'BACKUP_OPERATION_FAILED';
    const result = { status: 'failed', sourceId: SOURCE.id, attemptedAt: new Date().toISOString(), code };
    try { await jsonWrite(path.join(ROOT, 'last-attempt.json'), result); } catch { /* log metadata only */ }
    console.error(JSON.stringify(result)); process.exitCode = 1;
  });
}
