import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {runGeminiPrompt,deleteGeminiSession,getGeminiModelCatalog,getGeminiSessionDetail} from '../../server/geminiService.js';

const profileId=process.env.CODE_AI_ARGON_PROFILE||'gemini-developer';
const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'code-ai-argon-cli-'));
const results=[];
try{
  for(const effort of ['low','high']){
    let createdSessionId: string|null=null;
    try{
      const result=await runGeminiPrompt('Return exactly CODE_AI_ARGON_CLI_OK. Do not use tools, edit files or run commands.',undefined,profileId,[],{
        cwd:workspace,executionConfig:{model:'gemini-4-argon',reasoningEffort:effort},
        onSessionStarted:(id)=>{createdSessionId=id;},
      });
      createdSessionId=result.sessionId;
      const session=await getGeminiSessionDetail(result.sessionId,profileId);
      assert.ok(result.finalMessage.includes('CODE_AI_ARGON_CLI_OK'));
      assert.equal(session.modelProvider,'gemini-4-argon');
      results.push({effort,actualModel:session.modelProvider,passed:true});
    }finally{
      if(createdSessionId)await deleteGeminiSession(createdSessionId,profileId);
    }
  }
  const catalog=await getGeminiModelCatalog(profileId);
  assert.equal(catalog.selectedModel,'gemini-4-argon');
  assert.ok(!catalog.models.some(m=>m.slug==='gemini-3.1-pro-preview'||m.slug==='gemini-3-pro-preview'));
  assert.deepEqual(catalog.models.find(m=>m.slug==='gemini-4-argon')?.supportedReasoningLevels.map(l=>l.effort),['low','medium','high']);
  console.log(JSON.stringify({profileId,results,selectedModel:catalog.selectedModel}));
}finally{
  await fs.rmdir(workspace);
}
