import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const validatorStart = serverSource.indexOf('function isTargetLanguageDominantProse');
const validatorEnd = serverSource.indexOf('async function generateSmartNoteWithGemini', validatorStart);
assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, 'Smart Note validator source must be available.');

const validationLogs = [];
const context = { console: { warn: entry => validationLogs.push(String(entry)) } };
vm.runInNewContext(`${serverSource.slice(validatorStart, validatorEnd)}\nglobalThis.validateSmartNote = validateSmartNote;`, context);

const frontendSource = readFileSync(new URL('../src/services/index.js', import.meta.url), 'utf8');
const frontendValidatorStart = frontendSource.indexOf('function isTargetLanguageDominantProse');
const frontendValidatorEnd = frontendSource.indexOf('export class GeminiSmartNoteGenerator', frontendValidatorStart);
assert.ok(frontendValidatorStart >= 0 && frontendValidatorEnd > frontendValidatorStart, 'Frontend Smart Note validator source must be available.');
const frontendContext = {};
vm.runInNewContext(`${frontendSource.slice(frontendValidatorStart, frontendValidatorEnd)}\nglobalThis.validateSmartNotePayload = validateSmartNotePayload;`, frontendContext);

function koreanNote(term = '연결 리스트') {
  return {
    title: '자료구조 핵심 개념',
    summary: '강의에서는 연결 리스트와 자료 구조의 기본 원리를 설명했습니다.',
    keywords: [{ term, definition: '연결된 데이터를 관리하는 구조입니다.', lectureContext: '강의에서 노드 연결 방식을 다뤘습니다.', majorExplanation: '전공 학습에 중요합니다.', studyTip: '노드 관계를 그림으로 정리하세요.' }],
    studyTips: ['핵심 용어를 직접 설명해 보세요.'],
    quizzes: [
      { type: 'OX', question: '연결 리스트는 노드 연결을 사용합니다.', options: ['O', 'X'], answer: 'O', explanation: '강의에서 노드 연결 구조를 설명했습니다.' },
      { type: 'MC', question: '강의에서 다룬 핵심 구조는 무엇인가요?', options: ['연결 리스트', '운영체제', '컴파일러', '그래픽'], answer: '연결 리스트', explanation: '강의의 핵심 주제는 연결 리스트였습니다.' }
    ]
  };
}

function englishNote(summary = 'This is an English summary of the lecture.') {
  return {
    title: 'Data Structures Overview',
    summary,
    keywords: [{ term: 'Linked List', definition: 'A linked data structure.', lectureContext: 'The lecture compared node references.', majorExplanation: 'It is important for software design.', studyTip: 'Draw the node links.' }],
    studyTips: ['Explain the data structure aloud.'],
    quizzes: [
      { type: 'OX', question: 'A linked list uses nodes.', options: ['O', 'X'], answer: 'O', explanation: 'The lecture explained node links.' },
      { type: 'MC', question: 'What structure was discussed?', options: ['Linked list', 'Compiler', 'Browser', 'Database'], answer: 'Linked list', explanation: 'Linked lists were the lecture topic.' }
    ]
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function frontendPayload(note) {
  return {
    title: note.title,
    summary: note.summary,
    keyPoints: note.keyPoints || ['A key lecture point.'],
    keySentences: note.keySentences || ['A key lecture sentence.'],
    keywords: note.keywords.map(item => item.term),
    keywordDetails: Object.fromEntries(note.keywords.map(item => [item.term, { meaning: item.definition, context: item.lectureContext, major: item.majorExplanation, studyTip: item.studyTip }])),
    studyTips: [...note.studyTips],
    quizzes: clone(note.quizzes)
  };
}
function assertContractParity(note, language) {
  const backendNote = clone(note);
  context.validateSmartNote(backendNote, language);
  const backendResponse = frontendPayload(backendNote);
  assert.doesNotThrow(() => frontendContext.validateSmartNotePayload(backendResponse, language), 'A backend-approved Smart Note must pass frontend validation.');
  const frontendResponse = frontendPayload(clone(note));
  assert.doesNotThrow(() => frontendContext.validateSmartNotePayload(frontendResponse, language), 'The frontend must accept the same valid Smart Note contract.');
}

// Prose policy: selected-language chunks must be strictly dominant, with limited technical terms allowed.
assert.doesNotThrow(() => context.validateSmartNote(englishNote(), 'en'));
assert.doesNotThrow(() => context.validateSmartNote(englishNote('This English overview explains 자료구조 concepts.'), 'en'));
const koreanWithEnglishTechnicalTerm = koreanNote('JavaScript');
koreanWithEnglishTechnicalTerm.summary = '강의는 JavaScript 자료구조를 자세히 다룹니다.';
assert.doesNotThrow(() => context.validateSmartNote(koreanWithEnglishTechnicalTerm, 'ko'));
assert.throws(() => context.validateSmartNote(englishNote('이 강의는 자료구조와 SQL을 다룹니다.'), 'en'), /title or summary/);
validationLogs.length = 0;
const diagnosticSummary = 'SQL 자료구조';
assert.throws(() => context.validateSmartNote(englishNote(diagnosticSummary), 'en'), /title or summary/);
const summaryDiagnostic = JSON.parse(validationLogs.at(-1));
assert.deepEqual(summaryDiagnostic, {
  event: 'smart-note-validation-failed', stage: 'title-summary', field: 'summary', reason: 'target-language-not-dominant', language: 'en',
  englishChunkCount: 1, koreanChunkCount: 1, englishLetterCount: 3, koreanSyllableCount: 4
});
assert.equal(JSON.stringify(summaryDiagnostic).includes(diagnosticSummary), false, 'Summary content must never be logged.');
const englishOnlyKoreanNote = koreanNote('JavaScript');
englishOnlyKoreanNote.summary = 'This lecture explains JavaScript concepts.';
assert.throws(() => context.validateSmartNote(englishOnlyKoreanNote, 'ko'), /title or summary/);

// A single target-language chunk is valid prose; symbols and numbers alone are not.
assert.doesNotThrow(() => context.validateSmartNote(englishNote('Overview'), 'en'));
const shortKoreanNote = koreanNote('JavaScript');
shortKoreanNote.summary = '개요';
assert.doesNotThrow(() => context.validateSmartNote(shortKoreanNote, 'ko'));
assert.throws(() => context.validateSmartNote(englishNote('1234 !@#$%^&*'), 'en'), /title or summary/);

// Backend-approved Smart Notes must satisfy the frontend response contract as well.
const parityEnglishTechnical = englishNote('This English overview explains 자료구조 concepts.');
parityEnglishTechnical.keywords[0].term = '자료구조';
assertContractParity(parityEnglishTechnical, 'en');
const parityKoreanTechnical = koreanNote('JavaScript');
parityKoreanTechnical.summary = '강의는 JavaScript 자료구조를 자세히 다룹니다.';
assertContractParity(parityKoreanTechnical, 'ko');
const parityMixedTitle = englishNote();
parityMixedTitle.title = '자료구조 Data Structures';
assertContractParity(parityMixedTitle, 'en');
const parityMixedOption = englishNote();
parityMixedOption.quizzes[1].options[0] = '자료구조 (Data Structures)';
parityMixedOption.quizzes[1].answer = '자료구조 (Data Structures)';
assertContractParity(parityMixedOption, 'en');

// Labels may be meaningful mixed-language technical terms in either note language.
const mixedKeyword = englishNote();
mixedKeyword.keywords[0].term = '자료구조 Data Structures';
assert.doesNotThrow(() => context.validateSmartNote(mixedKeyword, 'en'));
const koreanKeywordInEnglishNote = englishNote();
koreanKeywordInEnglishNote.keywords[0].term = '자료구조';
assert.doesNotThrow(() => context.validateSmartNote(koreanKeywordInEnglishNote, 'en'));
assert.doesNotThrow(() => context.validateSmartNote(koreanNote('JavaScript'), 'ko'));
const mixedTitle = englishNote();
mixedTitle.title = '자료구조 Data Structures';
assert.doesNotThrow(() => context.validateSmartNote(mixedTitle, 'en'));
const technicalOption = englishNote();
technicalOption.quizzes[1].options[0] = '자료구조 (Data Structures)';
technicalOption.quizzes[1].answer = '자료구조 (Data Structures)';
assert.doesNotThrow(() => context.validateSmartNote(technicalOption, 'en'));
const emptyLabel = englishNote();
emptyLabel.title = '   ';
assert.throws(() => context.validateSmartNote(emptyLabel, 'en'), /title or summary/);
const symbolLabel = englishNote();
symbolLabel.keywords[0].term = '1234 / +';
assert.throws(() => context.validateSmartNote(symbolLabel, 'en'), /keyword details/);

// Existing structural quiz checks remain strict.
const tooFewQuizzes = englishNote();
tooFewQuizzes.quizzes = [tooFewQuizzes.quizzes[0]];
assert.throws(() => context.validateSmartNote(tooFewQuizzes, 'en'), /quizzes were incomplete/);
const badOxOptions = englishNote();
badOxOptions.quizzes[0].options = ['O'];
assert.throws(() => context.validateSmartNote(badOxOptions, 'en'), /quiz validation failed/);
const badMcOptions = englishNote();
badMcOptions.quizzes[1].options = ['Linked list', 'Compiler', 'Browser'];
assert.throws(() => context.validateSmartNote(badMcOptions, 'en'), /quiz validation failed/);
const duplicateOptions = englishNote();
duplicateOptions.quizzes[1].options = ['Linked list', 'Compiler', 'Compiler', 'Database'];
assert.throws(() => context.validateSmartNote(duplicateOptions, 'en'), /quiz validation failed/);
const invalidAnswer = englishNote();
invalidAnswer.quizzes[1].answer = 'Not an option';
assert.throws(() => context.validateSmartNote(invalidAnswer, 'en'), /quiz validation failed/);

// MC answers resolve only to one real option, then retain that option's original text.
function mcAnswerNote(answer, options) {
  const note = englishNote();
  note.quizzes[1].options = options || note.quizzes[1].options;
  note.quizzes[1].answer = answer;
  return note;
}
for (const [answer, expected] of [['Linked list', 'Linked list'], ['  Linked list  ', 'Linked list'], ['Ｃｏｍｐｉｌｅｒ', 'Compiler'], ['compiler', 'Compiler'], ['Queue.', 'Queue']]) {
  const note = answer === 'Queue.' ? mcAnswerNote(answer, ['Stack', 'Queue', 'Tree', 'Graph']) : mcAnswerNote(answer);
  const frontendNote = frontendPayload(clone(note));
  frontendContext.validateSmartNotePayload(frontendNote, 'en');
  assert.equal(frontendNote.quizzes[1].answer, expected);
  context.validateSmartNote(note, 'en');
  assert.equal(note.quizzes[1].answer, expected);
}
const nbspAnswer = mcAnswerNote('Priority\u00A0\u00A0Queue', ['Stack', 'Priority Queue', 'Tree', 'Graph']);
const frontendNbspAnswer = frontendPayload(clone(nbspAnswer));
frontendContext.validateSmartNotePayload(frontendNbspAnswer, 'en');
assert.equal(frontendNbspAnswer.quizzes[1].answer, 'Priority Queue');
context.validateSmartNote(nbspAnswer, 'en');
assert.equal(nbspAnswer.quizzes[1].answer, 'Priority Queue');
for (const [answer, expected] of [['A', 'Linked list'], ['B', 'Compiler'], ['C', 'Browser'], ['D', 'Database'], ['1', 'Linked list'], ['2', 'Compiler'], ['3', 'Browser'], ['4', 'Database']]) {
  const note = mcAnswerNote(answer);
  const frontendNote = frontendPayload(clone(note));
  frontendContext.validateSmartNotePayload(frontendNote, 'en');
  assert.equal(frontendNote.quizzes[1].answer, expected);
  context.validateSmartNote(note, 'en');
  assert.equal(note.quizzes[1].answer, expected);
}
const prefixedAnswer = mcAnswerNote('B. Queue', ['Stack', 'Queue', 'Tree', 'Graph']);
const frontendPrefixedAnswer = frontendPayload(clone(prefixedAnswer));
frontendContext.validateSmartNotePayload(frontendPrefixedAnswer, 'en');
assert.equal(frontendPrefixedAnswer.quizzes[1].answer, 'Queue');
context.validateSmartNote(prefixedAnswer, 'en');
assert.equal(prefixedAnswer.quizzes[1].answer, 'Queue');

// OX aliases canonicalize to O/X only when the two options represent both values.
for (const [answer, expected] of [['O', 'O'], ['X', 'X'], ['True', 'O'], ['False', 'X'], ['T', 'O'], ['F', 'X'], ['참', 'O'], ['거짓', 'X']]) {
  const note = englishNote();
  note.quizzes[0].answer = answer;
  const frontendNote = frontendPayload(clone(note));
  frontendContext.validateSmartNotePayload(frontendNote, 'en');
  assert.deepEqual(Array.from(frontendNote.quizzes[0].options), ['O', 'X']);
  assert.equal(frontendNote.quizzes[0].answer, expected);
  context.validateSmartNote(note, 'en');
  assert.deepEqual(Array.from(note.quizzes[0].options), ['O', 'X']);
  assert.equal(note.quizzes[0].answer, expected);
}

// Unsafe or ambiguous answer representations, malformed quizzes, and normalized duplicates still fail.
assert.throws(() => context.validateSmartNote(mcAnswerNote('Not an option'), 'en'), /quiz validation failed/);
assert.throws(() => context.validateSmartNote(mcAnswerNote('QUEUE', ['Queue', 'queue', 'Browser', 'Database']), 'en'), /quiz validation failed/);
assert.throws(() => context.validateSmartNote(mcAnswerNote('B. Stack', ['Stack', 'Queue', 'Tree', 'Graph']), 'en'), /quiz validation failed/);
assert.throws(() => context.validateSmartNote(mcAnswerNote('E'), 'en'), /quiz validation failed/);
assert.throws(() => context.validateSmartNote(mcAnswerNote('Priority Queue', ['Priority Queue', 'Priority\u00A0Queue', 'Browser', 'Database']), 'en'), /quiz validation failed/);
const unknownQuizType = englishNote();
unknownQuizType.quizzes[1].type = 'TF';
assert.throws(() => context.validateSmartNote(unknownQuizType, 'en'), /quiz validation failed/);
const malformedQuiz = englishNote();
malformedQuiz.quizzes[1] = null;
assert.throws(() => context.validateSmartNote(malformedQuiz, 'en'), /quiz validation failed/);

// The frontend rejects the same malformed or wrong-language response contract as the backend.
const frontendWrongLanguage = englishNote('이 강의는 자료구조를 다룹니다.');
assert.throws(() => frontendContext.validateSmartNotePayload(frontendPayload(frontendWrongLanguage), 'en'), /Smart Note response is incomplete/);
const frontendMalformed = englishNote();
frontendMalformed.quizzes[1] = null;
assert.throws(() => frontendContext.validateSmartNotePayload(frontendPayload(frontendMalformed), 'en'), /quiz validation failed/);
const frontendBadCount = englishNote();
frontendBadCount.quizzes[1].options = ['Linked list', 'Compiler', 'Browser'];
assert.throws(() => frontendContext.validateSmartNotePayload(frontendPayload(frontendBadCount), 'en'), /quiz validation failed/);
const frontendDuplicateOptions = englishNote();
frontendDuplicateOptions.quizzes[1].options = ['Priority Queue', 'Priority\u00A0Queue', 'Browser', 'Database'];
assert.throws(() => frontendContext.validateSmartNotePayload(frontendPayload(frontendDuplicateOptions), 'en'), /quiz validation failed/);
const frontendInvalidAnswer = englishNote();
frontendInvalidAnswer.quizzes[1].answer = 'Not an option';
assert.throws(() => frontendContext.validateSmartNotePayload(frontendPayload(frontendInvalidAnswer), 'en'), /quiz validation failed/);

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(appSource, /generationError \? `<p class="note-error" role="alert">\$\{esc\(generationError\)\}<\/p>` : ''/);
assert.match(appSource, /<button class="button" data-review-action="generate-note">/);

console.log('Smart Note unified language-validation and visible error-state regressions passed.');
