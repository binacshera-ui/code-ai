import assert from 'node:assert/strict';
import {test} from 'node:test';
import {terminalHistoryKey,terminalReadableText,terminalScrollLines} from './terminalInteraction';
test('wheel pixels, lines and pages retain direction and high-resolution trackpad movement',()=>{
  assert.equal(terminalScrollLines(-1,0,24,18),-1);
  assert.equal(terminalScrollLines(36,0,24,18),2);
  assert.equal(terminalScrollLines(-3,1,24,18),-3);
  assert.equal(terminalScrollLines(1,2,24,18),24);
});
test('ordinary TUI keys pass through and modified history keys navigate locally',()=>{
  const event={key:'PageUp',shiftKey:false,ctrlKey:false,altKey:false,metaKey:false};
  assert.equal(terminalHistoryKey(event),null);
  assert.equal(terminalHistoryKey({...event,shiftKey:true}),'pageUp');
  assert.equal(terminalHistoryKey({...event,key:'End',shiftKey:true,ctrlKey:true}),'bottom');
});
test('reader joins soft wraps and preserves logical Hebrew, English and punctuation',()=>{
  const lines=[{isWrapped:false,text:'שלום עולם '},{isWrapped:true,text:'GPU 123'},{isWrapped:false,text:'בדיקה נוספת'}];
  const buffer={length:lines.length,getLine:(i:number)=>({...lines[i],translateToString:()=>lines[i].text})};
  assert.equal(terminalReadableText(buffer),'שלום עולם GPU 123\nבדיקה נוספת');
  assert.equal(terminalReadableText(buffer,1),'בדיקה נוספת');
});
