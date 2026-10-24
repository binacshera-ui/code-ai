import test from 'node:test';import assert from 'node:assert/strict';
import {sudoExplicitlyDenied} from './auth-fixture.mjs';
test('sudo -l -U may return exit 0 while explicitly denying the user',()=>{
 assert.equal(sudoExplicitlyDenied('User codeai-ubuntu is not allowed to run sudo on web.\n'),true);
 for(const value of ['','User codeai-ubuntu may run the following commands on web:\n (ALL) NOPASSWD: ALL',
  'sudo: unknown user codeai-ubuntu','User another-user is not allowed to run sudo on web.'])assert.equal(sudoExplicitlyDenied(value),false);
});
