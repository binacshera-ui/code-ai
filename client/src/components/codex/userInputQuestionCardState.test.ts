import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodexUserInputQuestion } from '../../../../shared/codexUserInput';
import {
  buildUserInputQuestionResponse,
  createUserInputQuestionDrafts,
  redactUserInputQuestionAnswers,
  userInputQuestionAnswer,
  userInputQuestionAnswerSummary,
  userInputQuestionCardPresentation,
  userInputRequestKey,
} from './userInputQuestionCardState';

function question(overrides: Partial<CodexUserInputQuestion> = {}): CodexUserInputQuestion {
  return {
    id: 'location',
    header: 'מיקום',
    question: 'איזה מיקום מתאים?',
    isOther: true,
    isSecret: false,
    options: [
      { label: 'מקומי (מומלץ)', description: 'העבודה תישאר מקומית' },
      { label: 'מרוחק', description: 'העבודה תתבצע בשרת' },
    ],
    ...overrides,
  };
}

test('recommended options have no preselected/default answer', () => {
  const questions = [question()];
  const drafts = createUserInputQuestionDrafts(questions);
  assert.deepEqual(drafts.location, { selectedOption: null, useOther: false, text: '' });
  assert.equal(userInputQuestionAnswer(questions[0], drafts.location), null);
  assert.equal(buildUserInputQuestionResponse(questions, drafts), null);
  assert.equal(buildUserInputQuestionResponse([], {}), null);
});

test('one explicit radio selection returns the exact native label, not its description or index', () => {
  const questions = [question()];
  const drafts = createUserInputQuestionDrafts(questions);
  drafts.location.selectedOption = 1;
  drafts.location.text = 'a previous free-text draft';
  assert.deepEqual(buildUserInputQuestionResponse(questions, drafts), {
    answers: { location: { answers: ['מרוחק'] } },
  });
  assert.equal(drafts.location.text, 'a previous free-text draft');
  assert.equal(questions[0].options![1].label, 'מרוחק');
});

test('free-text Other is explicit, editable, and may be replaced by a radio selection', () => {
  const questions = [question()];
  const drafts = createUserInputQuestionDrafts(questions);
  drafts.location.text = '  אפשרות מותאמת  ';
  assert.equal(buildUserInputQuestionResponse(questions, drafts), null);
  drafts.location.useOther = true;
  assert.deepEqual(buildUserInputQuestionResponse(questions, drafts), {
    answers: { location: { answers: ['אפשרות מותאמת'] } },
  });
  drafts.location.useOther = false;
  drafts.location.selectedOption = 0;
  assert.deepEqual(buildUserInputQuestionResponse(questions, drafts), {
    answers: { location: { answers: ['מקומי (מומלץ)'] } },
  });
  assert.equal(drafts.location.text, '  אפשרות מותאמת  ');
});

test('Other is unavailable when the native question disallows it', () => {
  const restricted = question({ isOther: false });
  assert.equal(userInputQuestionAnswer(restricted, {
    selectedOption: 0, useOther: true, text: 'not allowed',
  }), null);
});

test('questions with no options accept direct text and reject blank nonsecret answers', () => {
  for (const options of [null, []]) {
    const freeText = question({ options, isOther: false });
    assert.equal(userInputQuestionAnswer(freeText, { selectedOption: null, useOther: false, text: '  תשובה\nנוספת  ' }), 'תשובה\nנוספת');
    assert.equal(userInputQuestionAnswer(freeText, { selectedOption: null, useOther: false, text: '\n  ' }), null);
  }
});

test('all questions must be answered and response contains only the current request ids', () => {
  const questions = [question(), question({ id: 'scope', options: null }), question({ id: 'timing', options: [] })];
  const drafts = createUserInputQuestionDrafts(questions);
  drafts.location.selectedOption = 0;
  drafts.scope.text = 'כל הפרויקט';
  drafts.unrelated = { selectedOption: null, useOther: false, text: 'stale answer' };
  assert.equal(buildUserInputQuestionResponse(questions, drafts), null);
  drafts.timing.text = 'היום';
  assert.deepEqual(buildUserInputQuestionResponse(questions, drafts), {
    answers: {
      location: { answers: ['מקומי (מומלץ)'] },
      scope: { answers: ['כל הפרויקט'] },
      timing: { answers: ['היום'] },
    },
  });
});

test('missing drafts, duplicate ids, empty ids, and stale option indices cannot submit', () => {
  assert.equal(buildUserInputQuestionResponse([question()], {}), null);
  const drafts = createUserInputQuestionDrafts([question()]);
  drafts.location.selectedOption = 0;
  assert.equal(buildUserInputQuestionResponse([question(), question()], drafts), null);
  assert.equal(buildUserInputQuestionResponse([question({ id: '' })], { '': drafts.location }), null);
  for (const selectedOption of [-1, 2, 0.5, NaN, Infinity]) {
    assert.equal(userInputQuestionAnswer(question(), { selectedOption, useOther: false, text: '' }), null);
  }
});

test('request keys isolate identical question/request ids across profiles and sessions without separator collisions', () => {
  const request = { profileId: 'one', sessionId: 'session', id: 'request' };
  assert.equal(userInputRequestKey(request), userInputRequestKey({ ...request }));
  assert.notEqual(userInputRequestKey(request), userInputRequestKey({ ...request, id: 'next' }));
  assert.notEqual(userInputRequestKey(request), userInputRequestKey({ ...request, profileId: 'two' }));
  assert.notEqual(userInputRequestKey(request), userInputRequestKey({ ...request, sessionId: 'other' }));
  assert.notEqual(
    userInputRequestKey({ profileId: 'one:two', sessionId: 'three', id: 'four' }),
    userInputRequestKey({ profileId: 'one', sessionId: 'two:three', id: 'four' }),
  );
  const firstDraft = createUserInputQuestionDrafts([question()]);
  firstDraft.location.selectedOption = 1;
  assert.equal(createUserInputQuestionDrafts([question()]).location.selectedOption, null);
});

test('secret input is sent verbatim but every retained receipt and summary is redacted', () => {
  const questions = [question({ id: 'token', options: null, isSecret: true }), question()];
  const drafts = createUserInputQuestionDrafts(questions);
  drafts.token.text = '  private-test-token  ';
  drafts.location.selectedOption = 1;
  const response = buildUserInputQuestionResponse(questions, drafts)!;
  assert.equal(response.answers.token.answers[0], '  private-test-token  ');
  const retained = redactUserInputQuestionAnswers(questions, {
    ...response.answers,
    stale: { answers: ['do not retain'] },
  });
  assert.deepEqual(retained, {
    token: { answers: ['[redacted]'] },
    location: { answers: ['מרוחק'] },
  });
  assert.equal(userInputQuestionAnswerSummary(questions[0], response.answers), 'תשובה חסויה נשלחה');
  assert.equal(userInputQuestionAnswerSummary(questions[0], undefined), 'תשובה חסויה נשלחה');
  assert.equal(userInputQuestionAnswerSummary(questions[1], retained), 'מרוחק');
  assert.equal(JSON.stringify(retained).includes('private-test-token'), false);
  assert.equal(response.answers.token.answers[0], '  private-test-token  ');
  retained.location.answers.push('changed receipt');
  assert.deepEqual(response.answers.location.answers, ['מרוחק']);
});

test('secret option selections are also masked in retained receipts', () => {
  const secret = question({ isSecret: true });
  const drafts = createUserInputQuestionDrafts([secret]);
  drafts.location.selectedOption = 0;
  const response = buildUserInputQuestionResponse([secret], drafts)!;
  assert.deepEqual(redactUserInputQuestionAnswers([secret], response.answers), {
    location: { answers: ['[redacted]'] },
  });
  assert.equal(userInputQuestionAnswerSummary(secret, response.answers).includes(secret.options![0].label), false);
});

test('special question ids remain own data keys and never read inherited drafts', () => {
  const questions = [question({ id: '__proto__' }), question({ id: 'constructor', options: null })];
  assert.equal(buildUserInputQuestionResponse(questions, {}), null);
  const drafts = createUserInputQuestionDrafts(questions);
  const constructorId: string = 'constructor';
  drafts.__proto__.selectedOption = 1;
  drafts[constructorId].text = 'safe text';
  const response = buildUserInputQuestionResponse(questions, drafts)!;
  assert.equal(Object.hasOwn(response.answers, '__proto__'), true);
  assert.deepEqual(response.answers.__proto__.answers, ['מרוחק']);
  assert.deepEqual(response.answers[constructorId].answers, ['safe text']);
});

test('blocking and asynchronous requests have distinct truthful pending presentations', () => {
  const blocking = userInputQuestionCardPresentation({ status: 'pending', isBlocking: true });
  const async = userInputQuestionCardPresentation({ status: 'pending', isBlocking: false });
  assert.equal(blocking.label, 'ממתין לתשובה');
  assert.equal(async.label, 'שאלה פתוחה');
  assert.match(blocking.description, /ממתין/);
  assert.match(async.description, /יכול להמשיך לעבוד/);
  assert.equal(async.description.includes('ממתין'), false);
});

test('answered, expired, cancelled and failed states stay distinct from pending', () => {
  assert.equal(userInputQuestionCardPresentation({ status: 'answered', isBlocking: true }).label, 'נענתה');
  assert.equal(userInputQuestionCardPresentation({ status: 'expired', isBlocking: false }).label, 'לא פעילה');
  assert.equal(userInputQuestionCardPresentation({ status: 'cancelled', isBlocking: true }).label, 'בוטלה');
  assert.equal(userInputQuestionCardPresentation({ status: 'failed', isBlocking: true }).label, 'החיבור הסתיים');
  assert.equal(userInputQuestionAnswerSummary(question(), undefined), 'התשובה נמסרה');
});
