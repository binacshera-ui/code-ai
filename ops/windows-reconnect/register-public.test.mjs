import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {normalizePublicKey, validateReport} from './register-public.mjs';

function key() {
  const {publicKey}=generateKeyPairSync('ed25519');
  const bytes=publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const blob=Buffer.alloc(51);blob.writeUInt32BE(11,0);blob.write('ssh-ed25519',4);blob.writeUInt32BE(32,15);bytes.copy(blob,19);
  return 'ssh-ed25519 '+blob.toString('base64');
}
const publicKey=key();
const base={format:'code-ai-windows-public-bootstrap',version:1,windowsUsername:'user',windowsComputerName:'NEW-PC',centralPublicKey:publicKey,pciPublicKey:publicKey,windowsHostPublicKey:publicKey};
test('public metadata is accepted and comments removed',()=>{
  assert.equal(normalizePublicKey(publicKey+' synthetic'),publicKey);
  assert.equal(validateReport(base).windowsUsername,'user');
});
test('private keys, malformed blobs and unrecognized fields are rejected',()=>{
  for(const key of ['-----BEGIN OPENSSH PRIVATE KEY-----','ssh-ed25519 aGVsbG8=','ssh-rsa AAAA'])assert.throws(()=>normalizePublicKey(key));
  assert.throws(()=>validateReport({...base,token:'not-permitted'}));
});
test('metadata cannot inject shell commands or SSH config',()=>{
  for(const user of ['root; id','name\nIdentityFile /other','AzureAD\\someone','-oProxyCommand=bad'])assert.throws(()=>validateReport({...base,windowsUsername:user}));
});
