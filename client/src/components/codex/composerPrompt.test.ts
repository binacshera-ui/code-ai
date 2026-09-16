import assert from 'node:assert/strict';
import test from 'node:test';
import { appendComposerPrompt } from './composerPrompt';

test('appends flow context without replacing an existing composer draft', () => {
  assert.equal(
    appendComposerPrompt('הטקסט שכבר כתבתי', 'התייחס למודול מסד הנתונים'),
    'הטקסט שכבר כתבתי\n\nהתייחס למודול מסד הנתונים',
  );
});

test('keeps clean spacing and handles an empty composer', () => {
  assert.equal(appendComposerPrompt('', '  בקשה מהמפה  '), 'בקשה מהמפה');
  assert.equal(appendComposerPrompt('טיוטה\n', 'בקשה מהמפה'), 'טיוטה\n\nבקשה מהמפה');
  assert.equal(appendComposerPrompt('טיוטה\n\n', 'בקשה מהמפה'), 'טיוטה\n\nבקשה מהמפה');
  assert.equal(appendComposerPrompt('טיוטה', '   '), 'טיוטה');
});
