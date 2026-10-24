import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Native daemon endpoints may be symlinks into Codex's private per-user /tmp
 * directory. Validate both ends, rather than either rejecting native links or
 * accepting an arbitrary socket. No runtime contents or error paths escape.
 */
export async function resolveCodexSharedSocket(codexHome, expectedUid, productOwner = false) {
  try {
    if (process.platform === 'win32' || typeof codexHome !== 'string'
        || !path.isAbsolute(codexHome) || !Number.isSafeInteger(expectedUid) || expectedUid < 0) {
      throw new Error();
    }
    const home = await realpath(codexHome);
    if (typeof productOwner !== 'boolean') throw new Error();
    const socketPath = productOwner
      ? path.join(home, 'code-ai-shared-owner', 'owner.sock')
      : path.join(home, 'app-server-control', 'app-server-control.sock');
    const parent = await lstat(path.dirname(socketPath));
    const endpoint = await lstat(socketPath);
    const resolvedSocketPath = await realpath(socketPath);
    const target = await lstat(resolvedSocketPath);
    const targetParent = await lstat(path.dirname(resolvedSocketPath));
    if (!parent.isDirectory() || !targetParent.isDirectory()
        || (!endpoint.isSocket() && !endpoint.isSymbolicLink()) || !target.isSocket()
        || [parent, endpoint, target, targetParent].some(entry => entry.uid !== expectedUid)
        || (parent.mode & 0o077) !== 0 || (targetParent.mode & 0o077) !== 0) {
      throw new Error();
    }
    return { codexHome: home, socketPath, resolvedSocketPath, uid: expectedUid };
  } catch {
    throw new Error('The canonical shared Codex owner is unavailable; no input was submitted');
  }
}
