import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {quoteTerminalExecutable,resolveTerminalCodexLaunch} from './codexTerminalLaunch.js';
test('launch pins the selected CLI and enables inline scrollback without installing a version',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'terminal-cli-'));
  try {
    const file=path.join(root,"codex's cli");
    writeFileSync(file,'#!/bin/sh\nif [ "$1" = "--help" ]; then printf -- "--remote <ADDR>\\n"; else printf "codex-cli 0.162.1\\n"; fi\n');chmodSync(file,0o700);
    const launch=resolveTerminalCodexLaunch('/bin/bash',{CODEX_BIN:file,PATH:'/usr/bin:/bin'});
    assert.equal(launch.version,'0.162.1');
    assert.equal(launch.command,`${quoteTerminalExecutable(file,'/bin/bash')} --sandbox danger-full-access --ask-for-approval never --no-alt-screen`);
    const shared = resolveTerminalCodexLaunch('/bin/bash',{CODEX_BIN:file,PATH:'/usr/bin:/bin'},'/private/profile/owner.sock');
    assert.equal(shared.command,`${quoteTerminalExecutable(file,'/bin/bash')} --remote 'unix:///private/profile/owner.sock' --sandbox danger-full-access --ask-for-approval never --no-alt-screen`);
    assert.deepEqual(resolveTerminalCodexLaunch('/bin/bash',{CODEX_BIN:file+'-missing',PATH:root}),{version:null,command:null});
  } finally {rmSync(root,{recursive:true});}
});
test('PowerShell quotes apostrophes without permitting command expansion',()=>{
  assert.equal(quoteTerminalExecutable("C:\\a'b\\codex.exe",'pwsh'),"& 'C:\\a''b\\codex.exe'");
});
