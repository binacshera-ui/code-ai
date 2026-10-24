import assert from 'node:assert/strict';
import {liveApi} from '../shared-defaults-fix/live-api.mjs';
export async function verifyLiveTerminal(){
 const {request}=await liveApi();
 const {terminal}=await request('/api/codex/terminal/sessions','POST',{profileId:'developer',cwd:'/root/projects/code-ai',columns:120,rows:32});
 const route='/api/codex/terminal/sessions/'+terminal.id;let cursor=0,output='';
 const poll=async(test,timeout=15000)=>{
  const until=Date.now()+timeout;
  while(Date.now()<until){const r=await request(route+'/output?cursor='+cursor);cursor=r.cursor;output+=r.data;if(test(output))return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('Live terminal acceptance timed out');
 };
 try {
  assert.equal(terminal.codexCliVersion,'0.162.1');assert.ok(terminal.codexLaunchCommand?.endsWith(' --no-alt-screen'));
  assert.ok(terminal.codexLaunchCommand.includes("--remote 'unix://"));
  await request(route+'/input','POST',{data:"printf 'CODE_AI_UTF8:%s שלום עולם GPU 123\\n' \"$(locale charmap)\"\r"});
  await poll(text=>text.includes('CODE_AI_UTF8:UTF-8 שלום עולם GPU 123'));
  output='';await request(route+'/input','POST',{data:terminal.codexLaunchCommand+'\r'});
  await poll(text=>text.includes('0.162.1') && /Codex/i.test(text),30000);
  // Exercise native input without submitting a model request; then quit our own PTY.
  await request(route+'/input','POST',{data:'\x1b[200~שלום עולם GPU 123\x1b[201~'});
  await poll(text=>text.includes('שלום')||text.includes('עולם'));
  await request(route+'/input','POST',{data:'\x03\x03'});
  return {verifiedAt:new Date().toISOString(),cliVersion:terminal.codexCliVersion,inlineLaunch:true,sharedOwnerExplicitlySelected:true,realPtyUtf8:true,realCodexTui:true,hebrewInput:true,modelRequestSubmitted:false,rawTerminalOutputSaved:false};
 }finally{await request(route,'DELETE').catch(()=>{});}
}
