import {execFileSync} from 'node:child_process';
execFileSync(process.execPath, ['--experimental-vm-modules', '--test',
  'scripts/personal-chrome-device-contract.test.mjs',
  'scripts/personal-chrome-panel-profile.test.mjs',
  'scripts/personal-chrome-panel-pairing.test.mjs',
  'scripts/personal-chrome-transport.test.mjs',
  'scripts/personal-chrome-background-startup.test.mjs',
  'scripts/personal-chrome-extension.test.mjs',
  'ops/windows-reconnect/register-public.test.mjs',
], {stdio:'inherit'});
