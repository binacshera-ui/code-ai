import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCodexCliVersion } from './codexCliAutoUpdate.js';

export function quoteTerminalExecutable(executable: string, shell: string): string {
  const name = path.basename(shell).toLowerCase();
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(name)) return `& '${executable.replace(/'/g, "''")}'`;
  if (/^cmd(?:\.exe)?$/.test(name)) return `"${executable.replace(/["\r\n]/g, '')}"`;
  return `'${executable.replace(/'/g, "'\\''")}'`;
}

/** Resolve before the login shell can replace PATH. Do not install or change a CLI. */
export function resolveTerminalCodexLaunch(shell: string, env: NodeJS.ProcessEnv = process.env, sharedSocket?: string): {version: string | null; command: string | null} {
  const configured = env.CODEX_TERMINAL_BIN || env.CODE_AI_CODEX_NATIVE_BIN || env.CODEX_BIN || 'codex';
  const candidates = path.isAbsolute(configured) || configured.includes(path.sep)
    ? [configured]
    : (env.PATH || '').split(path.delimiter).flatMap(directory => process.platform === 'win32'
      ? ['.exe', '.cmd', ''].map(extension => path.join(directory, configured + extension))
      : [path.join(directory, configured)]);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const executable = realpathSync(candidate);
      const result = spawnSync(executable, ['--version'], {env, encoding:'utf8', timeout:5000, windowsHide:true});
      const version = result.status === 0 ? parseCodexCliVersion(result.stdout) : null;
      if (!version) return {version:null,command:null};
      let remote = '';
      if (sharedSocket) {
        const help = spawnSync(executable, ['--help'], {env,encoding:'utf8',timeout:5000,windowsHide:true});
        if (help.status !== 0 || !help.stdout.includes('--remote <ADDR>')) return {version,command:null};
        remote = ` --remote '${('unix://' + sharedSocket).replace(/'/g, "'\\''")}'`;
      }
      return {version,command:`${quoteTerminalExecutable(executable, shell)}${remote} --sandbox danger-full-access --ask-for-approval never --no-alt-screen`};
    } catch { /* Try another PATH directory, without falling back from an explicit executable. */ }
  }
  return {version:null,command:null};
}
