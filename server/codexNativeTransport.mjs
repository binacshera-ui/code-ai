/** Native item events include full inline images, not merely references.
 * Keep one consistent finite frame bound across every local transport hop.
 * The queued-byte bound is separate: two valid frames may arrive in a burst.
 */
export const NATIVE_FRAME_BYTES = 64 * 1024 * 1024;
export const NATIVE_BUFFER_BYTES = 128 * 1024 * 1024;

export const NATIVE_HISTORY_READS = new Set(['thread/read', 'thread/turns/list', 'thread/items/list']);
export function assertNativeHistoryRead(method, params) {
  if (!NATIVE_HISTORY_READS.has(method) || !params || typeof params !== 'object'
      || typeof params.threadId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(params.threadId)) {
    throw new Error('Only native history reads are permitted');
  }
}
