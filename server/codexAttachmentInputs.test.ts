import assert from 'node:assert/strict';
import test from 'node:test';
import { isCodexInlineImage } from './codexAttachmentInputs.js';

test('supported raster image inputs remain inline', () => {
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG; charset=binary']) {
    assert.equal(isCodexInlineImage({ isImage: true, mimeType, path: '/uploads/image' }), true);
  }
});

test('SVG and other non-inline image formats are attached as files instead of rejecting the message', () => {
  for (const mimeType of ['image/svg+xml', 'image/bmp', 'image/tiff', 'image/heic', 'application/pdf', '']) {
    assert.equal(isCodexInlineImage({ isImage: true, mimeType, path: '/uploads/reference' }), false);
  }
  assert.equal(isCodexInlineImage({ isImage: true, mimeType: 'image/png', path: '/uploads/cursor.SVG' }), false);
});

test('non-image attachments never become native image inputs from MIME alone', () => {
  assert.equal(isCodexInlineImage({ isImage: false, mimeType: 'image/png', path: '/uploads/image.png' }), false);
});
