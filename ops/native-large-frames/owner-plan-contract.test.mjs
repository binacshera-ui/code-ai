import test from 'node:test';import assert from 'node:assert/strict';import{selectOwnerPlanFile}from'./owner-plan-contract.mjs';
const id='aff5bbc8-e0a0-4d34-8bd1-a04f42a95036',dir='/home/developer/code-ai-native-owner',file=dir+'/profile-'+id+'.json';
test('actual systemd ExecStart selects exactly the owner-local pinned plan',()=>assert.equal(selectOwnerPlanFile('{ path=/opt/node ; argv[]=/opt/node /opt/profile-runner.mjs '+file+' ; ignore_errors=no ; }',dir),file));
test('foreign owner plan is never inferred or adopted',()=>assert.throws(()=>selectOwnerPlanFile('/opt/node /other/profile-'+id+'.json',dir)));
test('multiple plan arguments fail before installed effects',()=>assert.throws(()=>selectOwnerPlanFile(file+' '+file,dir)));
test('missing and undefined controller identities never become filesystem paths',()=>{for(const s of['','/home/developer/code-ai-native-owner/profile-undefined.json'])assert.throws(()=>selectOwnerPlanFile(s,dir));});
