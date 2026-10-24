/** UI image previews are broader than Codex's native inline-image contract.
 * Unsupported formats remain attached files; never send them as localImage or
 * --image inputs, since native queue admission rejects the entire message. */
const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isCodexInlineImage(attachment: { isImage: boolean; mimeType: string; path: string }): boolean {
  const mime = attachment.mimeType.split(';', 1)[0].trim().toLowerCase();
  return attachment.isImage && INLINE_IMAGE_MIME_TYPES.has(mime) && !/\.svgz?$/i.test(attachment.path);
}
