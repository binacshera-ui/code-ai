import assert from 'node:assert/strict';
export function releaseOverrideName({releaseOrder,buildId}) {
  assert.match(releaseOrder,/^[0-9]{13}$/);
  assert.match(buildId,/^[a-f0-9-]{36}$/);
  return 'zzzzzzz-code-ai-runtime-'+releaseOrder+'-'+buildId+'.conf';
}
export function assertEffectiveRelease({workingDirectory,command,candidate}) {
  assert.equal(workingDirectory,candidate,'Effective working directory is not the candidate');
  assert.ok(command.includes(candidate+'/'),'Effective command is not the candidate');
}
