import { readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
export const copyOptions={recursive:true,verbatimSymlinks:true};
export async function assertContainedLinks(root) {
  root=path.resolve(root);
  let links=0;
  async function inspect(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()) {
        const target=await readlink(file);
        const resolved=path.resolve(dir,target);
        assert.ok(!path.isAbsolute(target) && resolved.startsWith(root+path.sep),'Runtime link must be relative and stay within its artifact: '+path.relative(root,file));
        links++;
      } else if(entry.isDirectory()) await inspect(file);
    }
  }
  await inspect(root);
  return {containedSymbolicLinks:links};
}
