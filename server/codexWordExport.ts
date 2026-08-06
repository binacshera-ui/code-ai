const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_WORD_EXPORT_URL = 'http://127.0.0.1:8092/create_download';
const MAX_MARKDOWN_BYTES = 5_000_000;
const MAX_DOCX_BYTES = 64 * 1024 * 1024;
const WORD_EXPORT_TIMEOUT_MS = 120_000;

export class CodexWordExportError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'CodexWordExportError';
    this.statusCode = statusCode;
  }
}

export interface CodexWordDocument {
  bytes: Buffer;
  filename: string;
  mimeType: typeof DOCX_MIME;
}

interface ExportCodexMarkdownToWordOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  signal?: AbortSignal;
}

function cleanWordExportName(value: unknown): string {
  const base = String(value || 'תשובת-Codex')
    .replace(/[\\/:*?"<>|\x00-\x1f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120) || 'תשובת-Codex';
  return base.toLocaleLowerCase('en-US').endsWith('.docx') ? base : `${base}.docx`;
}

function readUpstreamError(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const payload = JSON.parse(trimmed) as { error?: unknown; detail?: unknown };
    const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';
    const error = typeof payload.error === 'string' ? payload.error.trim() : '';
    return (detail || error).slice(0, 600) || null;
  } catch {
    return trimmed.replace(/\s+/gu, ' ').slice(0, 600);
  }
}

function resolveWordExportEndpoint(configuredEndpoint?: string): string {
  const endpoint = configuredEndpoint?.trim()
    || process.env.CODEX_WORD_EXPORT_URL?.trim()
    || DEFAULT_WORD_EXPORT_URL;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new CodexWordExportError('כתובת שירות יצוא Word אינה תקינה.', 500);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CodexWordExportError('כתובת שירות יצוא Word אינה נתמכת.', 500);
  }
  return parsed.toString();
}

function validateDocxBytes(bytes: Buffer): void {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new CodexWordExportError('שירות Word החזיר קובץ שאינו DOCX תקין.', 502);
  }
}

export function buildWordAttachmentDisposition(filename: string): string {
  const safeFilename = cleanWordExportName(filename);
  const asciiFallback = safeFilename
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\]/gu, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
}

export async function exportCodexMarkdownToWord(
  input: { markdown: unknown; name?: unknown },
  options: ExportCodexMarkdownToWordOptions = {}
): Promise<CodexWordDocument> {
  if (typeof input.markdown !== 'string' || !input.markdown.trim()) {
    throw new CodexWordExportError('אין תוכן ליצוא Word.', 400);
  }

  const markdownBytes = Buffer.byteLength(input.markdown, 'utf8');
  if (markdownBytes > MAX_MARKDOWN_BYTES) {
    throw new CodexWordExportError('ההודעה גדולה מדי ליצוא Word אחד.', 413);
  }

  const filename = cleanWordExportName(input.name);
  const endpoint = resolveWordExportEndpoint(options.endpoint);
  const fetchImpl = options.fetchImpl || fetch;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        accept: DOCX_MIME,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ markdown: input.markdown, name: filename }),
      signal: options.signal || AbortSignal.timeout(WORD_EXPORT_TIMEOUT_MS),
    });
  } catch (error: any) {
    const isTimeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw new CodexWordExportError(
      isTimeout
        ? 'יצוא Word ארך זמן רב מדי ונעצר.'
        : 'שירות יצוא Word אינו זמין כרגע.',
      isTimeout ? 504 : 503
    );
  }

  if (!response.ok) {
    const detail = readUpstreamError(await response.text().catch(() => ''));
    const upstreamStatus = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new CodexWordExportError(
      detail ? `יצוא Word נכשל: ${detail}` : `שירות Word החזיר שגיאה ${response.status}.`,
      upstreamStatus
    );
  }

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCX_BYTES) {
    throw new CodexWordExportError('קובץ ה־Word שנוצר גדול מדי להורדה.', 413);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOCX_BYTES) {
    throw new CodexWordExportError('קובץ ה־Word שנוצר גדול מדי להורדה.', 413);
  }
  validateDocxBytes(bytes);

  return {
    bytes,
    filename,
    mimeType: DOCX_MIME,
  };
}
