import {execFileSync} from 'node:child_process';
execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:'payload',stdio:'inherit',timeout:120000});
execFileSync(process.execPath,['--test','ops/native-owner/profile-runner.test.mjs','ops/native-owner/profile-artifacts.test.mjs'],{cwd:'payload',stdio:'inherit',timeout:180000});
for(const file of ['ops/native-unlock-release/prepare-owner.mjs','ops/native-unlock-release/migrate-ubuntu-gui.mjs','ops/native-unlock-release/activate-host.mjs','ops/native-unlock-release/supervisor.mjs','ops/native-unlock-release/archive-failed-alias.mjs'])execFileSync(process.execPath,['--check',file],{cwd:'payload',stdio:'inherit'});
