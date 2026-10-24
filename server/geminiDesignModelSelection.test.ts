import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CODEX_APP_CONFIG} from './config.js';
import {setSessionDesignMode,getSessionDesignModeRecord,dispatchDesignConsultationForTests,
  setGeminiDesignInvokerForTests,setGeminiDesignModelCatalogProviderForTests,
  deleteSessionDesignMode,shutdownCodexDesignModeBridge} from './codexDesignMode.js';

test('all six design tools use Argon for balanced and deep quality despite an earlier selected model',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'code-ai-argon-design-'));
  const geminiHome=path.join(root,'gemini-home');
  const workspace=path.join(root,'workspace');
  await fs.mkdir(geminiHome);await fs.mkdir(workspace);
  const geminiProfile={id:'argon-test-gemini',label:'Argon fixture',provider:'gemini' as const,codexHome:geminiHome,workspaceCwd:workspace,defaultProfile:false};
  CODEX_APP_CONFIG.profiles.push(geminiProfile);
  const sourceProfile='argon-test-codex',sessionKey='draft-argon-design';
  const requestedModels:string[]=[];
  try{
    const makeModel=(slug:string)=>({slug,displayName:slug,description:null,defaultReasoningLevel:'medium',supportedReasoningLevels:[],isConfiguredDefault:false});
    setGeminiDesignModelCatalogProviderForTests(async()=>({models:['gemini-3.1-pro-preview','gemini-2.5-flash','gemini-4-argon'].map(makeModel),selectedModel:'gemini-3.1-pro-preview'} as any));
    setGeminiDesignInvokerForTests(async input=>{
      requestedModels.push(String(input.model));
      return {model:input.model||null,finalMessage:JSON.stringify({version:'1.0',executive_direction:'Preserve the interaction.',preserve_exactly:['Existing behavior'],implementation_handoff:[{file_hint:'Card.tsx',code_snippet:'color: inherit;',instruction:'Keep the current color.'}]})};
    });
    await setSessionDesignMode(sourceProfile,sessionKey,{enabled:true,geminiProfileId:geminiProfile.id,quality:'deep'});
    const stored=await getSessionDesignModeRecord(sourceProfile,sessionKey);assert.ok(stored);
    for(const quality of ['balanced','deep'] as const){
      for(const toolName of ['design_system','design_screen','design_component','design_review','design_responsive','design_polish']){
        const result=await dispatchDesignConsultationForTests({profileId:sourceProfile,sessionKey,workspaceCwd:workspace,record:{...stored,quality},toolName,arguments:{request:'Verify model selection without changing behavior.',canvas_input:{mode:'omit',reason:'Model selection test has no visual reference.'}}});
        assert.equal(result.model,'gemini-4-argon',quality+':'+toolName);
      }
    }
    assert.equal(requestedModels.length,12);
    assert.deepEqual([...new Set(requestedModels)],['gemini-4-argon']);
    setGeminiDesignModelCatalogProviderForTests(async()=>({models:[makeModel('gemini-3.1-pro-preview')],selectedModel:'gemini-3.1-pro-preview'} as any));
    await assert.rejects(dispatchDesignConsultationForTests({profileId:sourceProfile,sessionKey,workspaceCwd:workspace,record:stored,toolName:'design_polish',arguments:{request:'No fallback.',canvas_input:{mode:'omit',reason:'No canvas.'}}}),(error:any)=>error.designToolError?.error_code==='DESIGN_REQUIRED_MODEL_UNAVAILABLE');
    assert.equal(requestedModels.length,12,'unavailable Argon must not call the earlier model');
  }finally{
    setGeminiDesignInvokerForTests(null);setGeminiDesignModelCatalogProviderForTests(null);
    await shutdownCodexDesignModeBridge();
    await deleteSessionDesignMode(sourceProfile,sessionKey).catch(()=>undefined);
    CODEX_APP_CONFIG.profiles.splice(CODEX_APP_CONFIG.profiles.indexOf(geminiProfile),1);
    await fs.rm(root,{recursive:true,force:true});
  }
});
