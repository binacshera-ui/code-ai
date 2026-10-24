/** One owner for shipped Codex program selection. Never resolve from a profile
 * workspace: a login shell or historical APP_ROOT is not a runtime release.
 */
import path from 'node:path';import {fileURLToPath} from 'node:url';import {statSync,realpathSync} from 'node:fs';
export const codexRuntimePrograms=Object.freeze({
 sharedModes:'codex-shared-modes/mcp.mjs',personal_chrome:'personal-chrome/personal_chrome_mcp_server.mjs',
 phone_mode:'phone-mode/phone_mode_mcp_server.mjs',design_mode:'design-mode/design_mode_mcp_server.mjs',
 ux_mode:'ux-mode/ux_mode_mcp_server.mjs',browser_mode:'browser-mode/python/browser_mode_mcp_server.py',
 accountAuth:'codexSharedAccountAuth.mjs',sharedStdio:'codex-shared-stdio.mjs',sharedBroker:'codexSharedOwnerBroker.mjs',
 workMode:'../scripts/codex-work-mode.mjs',
});
export function resolveCodexRuntimeProgram(name,{moduleUrl=import.meta.url,sourceRoot}={}) {
 const relative=codexRuntimePrograms[name];if(!relative)throw Error('CODEX_RUNTIME_PROGRAM_UNKNOWN');
 const directory=path.dirname(fileURLToPath(moduleUrl)),parent=path.dirname(directory);
 const candidates=[path.join(directory,relative),path.join(parent,'server',relative),path.join(parent,'dist',relative)];
 if(sourceRoot)candidates.push(path.join(sourceRoot,'server',relative),path.join(sourceRoot,'dist',relative));
 for(const f of new Set(candidates))try{if(statSync(f).isFile())return realpathSync(f);}catch{}
 throw Object.assign(Error('MODE_PROGRAM_UNAVAILABLE'),{program:name});
}
