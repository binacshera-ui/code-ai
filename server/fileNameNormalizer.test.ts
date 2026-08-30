import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeMultipartFileName,
  normalizeCanonicalFileName,
} from './fileNameNormalizer.js';

function asMulterLatin1(value: string): string {
  return Buffer.from(value, 'utf8').toString('latin1');
}

test('repairs UTF-8 Hebrew filenames decoded as latin1 by multipart parsers', () => {
  const original = 'סיכום פגישה – גרסה 2.docx';
  const received = asMulterLatin1(original);

  assert.notEqual(received, original);
  assert.equal(decodeMultipartFileName(received), original);
  assert.equal(normalizeCanonicalFileName(decodeMultipartFileName(received)), original);
});

test('repairs other UTF-8 names without damaging extensions', () => {
  for (const original of ['café.pdf', '日本語の資料.txt', '📎 קובץ בדיקה.png']) {
    assert.equal(decodeMultipartFileName(asMulterLatin1(original)), original);
  }
});

test('does not reinterpret already-correct Unicode or genuine latin1 text', () => {
  assert.equal(decodeMultipartFileName('מסמך תקין.pdf'), 'מסמך תקין.pdf');
  assert.equal(decodeMultipartFileName('café.pdf'), 'café.pdf');
  assert.equal(decodeMultipartFileName('plain-file.txt'), 'plain-file.txt');
});
