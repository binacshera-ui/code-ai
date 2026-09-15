// Shared by the composer and multipart endpoint. Limits apply per selection;
// attachments already in a conversation do not count against later selections.
export const MAX_UPLOAD_FILE_BYTES = 75 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 40;
// Leave multipart overhead below the 100 MiB reverse-proxy request limit.
export const MAX_UPLOAD_BATCH_BYTES = MAX_UPLOAD_FILE_BYTES;

export function planUploadBatches<T extends { name: string; size: number }>(files: readonly T[]): T[][] {
  if (files.length > MAX_UPLOAD_FILES) {
    throw new Error(`ניתן להעלות עד ${MAX_UPLOAD_FILES} קבצים בכל בחירה. אפשר לצרף קבצים נוספים לאחר מכן.`);
  }
  // Validate the entire selection before uploading any files.
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`הקובץ "${file.name}" גדול מדי. הגודל המרבי לקובץ הוא 75MB.`);
    }
  }
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const file of files) {
    if (batch.length && bytes + file.size > MAX_UPLOAD_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
