import { execFileSync } from 'node:child_process';
execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:'payload',stdio:'inherit'});
execFileSync('node',['--experimental-vm-modules','--test','scripts/personal-chrome-device-contract.test.mjs','scripts/personal-chrome-panel-profile.test.mjs','scripts/personal-chrome-transport.test.mjs','scripts/personal-chrome-background-startup.test.mjs','scripts/personal-chrome-extension.test.mjs'],{cwd:'payload',stdio:'inherit'});
