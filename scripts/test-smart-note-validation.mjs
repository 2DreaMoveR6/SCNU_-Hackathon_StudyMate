import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const validatorStart = serverSource.indexOf('function isTargetLanguageDominantProse');
const validatorEnd = serverSource.indexOf('async function generateSmartNoteWithGemini', validatorStart);
assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, 'Smart Note validator source must be available.');

const context = {};
vm.runInNewContext(`${serverSource.slice(validatorStart, validatorEnd)}\nglobalThis.validateSmartNote = validateSmartNote;`, context);

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

// Prose policy: selected-language chunks must be strictly dominant, with limited technical terms allowed.
assert.doesNotThrow(() => context.validateSmartNote(englishNote(), 'en'));
assert.doesNotThrow(() => context.validateSmartNote(englishNote('This English overview explains 자료구조 concepts.'), 'en'));
const koreanWithEnglishTechnicalTerm = koreanNote('JavaScript');
koreanWithEnglishTechnicalTerm.summary = '강의는 JavaScript 자료구조를 자세히 다룹니다.';
assert.doesNotThrow(() => context.validateSmartNote(koreanWithEnglishTechnicalTerm, 'ko'));
assert.throws(() => context.validateSmartNote(englishNote('이 강의는 자료구조와 SQL을 다룹니다.'), 'en'), /title or summary/);
const englishOnlyKoreanNote = koreanNote('JavaScript');
englishOnlyKoreanNote.summary = 'This lecture explains JavaScript concepts.';
assert.throws(() => context.validateSmartNote(englishOnlyKoreanNote, 'ko'), /title or summary/);

// A single target-language chunk is valid prose; symbols and numbers alone are not.
assert.doesNotThrow(() => context.validateSmartNote(englishNote('Overview'), 'en'));
const shortKoreanNote = koreanNote('JavaScript');
shortKoreanNote.summary = '개요';
assert.doesNotThrow(() => context.validateSmartNote(shortKoreanNote, 'ko'));
assert.throws(() => context.validateSmartNote(englishNote('1234 !@#$%^&*'), 'en'), /title or summary/);

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

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(appSource, /generationError \? `<p class="note-error" role="alert">\$\{esc\(generationError\)\}<\/p>` : ''/);
assert.match(appSource, /<button class="button" data-review-action="generate-note">/);

console.log('Smart Note unified language-validation and visible error-state regressions passed.');
