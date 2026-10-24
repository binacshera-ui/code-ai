import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {validateReport,validateKey,handoff,HANDOFF_FIELDS,relayArguments,allowedCommand} from './contract.mjs';
const report=JSON.parse(fs.readFileSync(new URL('code-ai-ubuntu-public.json',import.meta.url),'utf8'));
test('actual Ubuntu report: exact fields, distinct valid ED25519 wire keys',()=>{
 assert.equal(Object.keys(validateReport(report)).length,3);
 for(const bad of [{...report,extra:true},{...report,ubuntuUsername:'showp'}, {...report,format:'code-ai-windows-public-bootstrap'}, {...report,pciPublicKey:report.centralPublicKey}])assert.throws(()=>validateReport(bad));
 assert.throws(()=>validateKey(report.centralPublicKey+'x'));
 assert.throws(()=>validateKey(report.centralPublicKey.replace('ssh-ed25519','ssh-rsa')));
});
test('handoff has exactly eleven public fields and a separate integer port',()=>{
 const result=handoff(report,report.centralPublicKey,44023,true,true);
 assert.deepEqual(Object.keys(result).sort(),[...HANDOFF_FIELDS].sort());
 assert.equal(result.ubuntuUsername,'refael');assert.equal(result.ubuntuComputerName,'gpu-lab');
 assert.throws(()=>handoff(report,report.centralPublicKey,44022,true,true));
 assert.throws(()=>handoff(report,report.centralPublicKey,'44023',true,true));
 assert.throws(()=>handoff(report,report.centralPublicKey,44023,'true',true));
});
test('PCI relay only reaches the Ubuntu alias with explicit fixed commands',()=>{
 for(const c of ['hostname','id','id -un']){const args=relayArguments(c);assert.equal(args.at(-2),'personal-ubuntu-ssh');assert.equal(args.at(-1),c);}
 for(const c of ['','sh','sudo id','hostname; id','hostname && id','sftp','cat /etc/shadow','id\nwhoami','hostname\0'])assert.throws(()=>allowedCommand(c));
});
