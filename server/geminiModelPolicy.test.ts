import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GEMINI_PRIMARY_MODEL,GEMINI_ARGON_REASONING_LEVELS,resolveGeminiRunModel,geminiThinkingConfig} from './geminiModelPolicy.js';

test('new work and cached Pro selections use Gemini 4 Argon',()=>{
  for(const model of [undefined,null,'','gemini-3.1-pro-preview','gemini-3-pro-preview'])
    assert.equal(resolveGeminiRunModel(model),GEMINI_PRIMARY_MODEL);
  assert.equal(resolveGeminiRunModel('gemini-3.8-flash'),'gemini-3.8-flash');
});
test('Argon uses supported thinking levels, including legacy queued effort values',()=>{
  assert.deepEqual(GEMINI_ARGON_REASONING_LEVELS.map(l=>l.effort),['low','medium','high']);
  for(const [old,current] of [['none','low'],['low','low'],['medium','medium'],['high','high'],['max','high']])
    assert.deepEqual(geminiThinkingConfig(GEMINI_PRIMARY_MODEL,old),{thinkingLevel:current});
});
test('explicit earlier model choices retain their supported budget contract',()=>{
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-pro','high'),{thinkingBudget:8192});
});
