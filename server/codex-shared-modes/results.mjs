// Preserve the existing mode MCP result conventions, including image blocks.
export function modeResult(server, value) {
  if (server === 'personal_chrome' && value && typeof value.imageDataUrl === 'string') {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value.imageDataUrl);
    if (match) {
      const metadata = { ...value }; delete metadata.imageDataUrl;
      return { isError: false, content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) },
        { type: 'image', mimeType: match[1], data: match[2] }] };
    }
  }
  let image = null;
  const findImage = (child, depth = 0) => {
    if (!child || typeof child !== 'object' || depth > 6) return null;
    if (typeof child.imageBase64 === 'string' && child.imageBase64.length) return {
      type: 'image', data: child.imageBase64, mimeType: typeof child.mimeType === 'string' ? child.mimeType : 'image/jpeg' };
    for (const nested of Object.values(child)) { const found = findImage(nested, depth + 1); if (found) return found; }
    return null;
  };
  if (server === 'phone_mode') image = findImage(value);
  const text = JSON.stringify(value ?? null, server === 'phone_mode' ? (key, child) =>
    key === 'imageBase64' && typeof child === 'string' ? `[image data omitted: ${child.length} base64 chars]` : child : null, 2);
  const limit = server === 'phone_mode' ? 120000 : server === 'personal_chrome' ? 100000 : 8 * 1024 * 1024;
  return { isError: false, content: [{ type: 'text', text: text.length > limit ? text.slice(0, limit) + '\n…[bounded]' : text },
    ...(image ? [image] : [])],
    ...(server !== 'personal_chrome' && server !== 'phone_mode' ? { structuredContent: value } : {}) };
}
