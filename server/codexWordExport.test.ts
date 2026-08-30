import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWordAttachmentDisposition,
  CodexWordExportError,
  exportCodexMarkdownToWord,
} from './codexWordExport.js';

test('exports Codex markdown through the configured DOCX service contract', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const result = await exportCodexMarkdownToWord(
    {
      markdown: '# כותרת\n\n1. ראשון\n2. שני',
      name: 'תשובה: מקצועית',
    },
    {
      endpoint: 'http://word-export.test/create_download',
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body || '{}')),
        });
        return new Response(Buffer.from('PK mock docx'), {
          status: 200,
          headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        });
      },
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'http://word-export.test/create_download');
  assert.deepEqual(requests[0]?.body, {
    markdown: '# כותרת\n\n1. ראשון\n2. שני',
    name: 'תשובה- מקצועית.docx',
  });
  assert.equal(result.filename, 'תשובה- מקצועית.docx');
  assert.equal(result.bytes.subarray(0, 2).toString('ascii'), 'PK');
});

test('rejects empty markdown before calling the Word service', async () => {
  let called = false;
  await assert.rejects(
    () => exportCodexMarkdownToWord(
      { markdown: '   ' },
      {
        fetchImpl: async () => {
          called = true;
          return new Response();
        },
      }
    ),
    (error: unknown) => error instanceof CodexWordExportError && error.statusCode === 400
  );
  assert.equal(called, false);
});

test('rejects a successful upstream response that is not a DOCX zip', async () => {
  await assert.rejects(
    () => exportCodexMarkdownToWord(
      { markdown: 'תוכן' },
      { fetchImpl: async () => new Response(Buffer.from('not a docx'), { status: 200 }) }
    ),
    /אינו DOCX תקין/u
  );
});

test('returns a Unicode-safe Content-Disposition header', () => {
  const header = buildWordAttachmentDisposition('תשובת קודקס.docx');
  assert.match(header, /filename="_+/u);
  assert.match(header, /filename\*=UTF-8''%D7%AA/u);
  assert.doesNotMatch(header, /[\r\n]/u);
});
