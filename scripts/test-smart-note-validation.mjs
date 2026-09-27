import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const validatorStart = serverSource.indexOf('function isContentLanguage');
const validatorEnd = serverSource.indexOf('async function generateSmartNoteWithGemini', validatorStart);
assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, 'Smart Note validator source must be available.');

const context = {};
vm.runInNewContext(`${serverSource.slice(validatorStart, validatorEnd)}\nglobalThis.validateSmartNote = validateSmartNote;`, context);

function koreanNote(term) {
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

for (const term of ['JavaScript', 'SQL', 'TCP/IP', 'Linked List']) {
  assert.doesNotThrow(() => context.validateSmartNote(koreanNote(term), 'ko'), `${term} must be accepted as a Korean-note technical keyword.`);
}

const englishSummary = koreanNote('JavaScript');
englishSummary.summary = 'English-only summary.';
assert.throws(() => context.validateSmartNote(englishSummary, 'ko'), /title or summary/);

const englishDefinition = koreanNote('SQL');
englishDefinition.keywords[0].definition = 'English-only definition.';
assert.throws(() => context.validateSmartNote(englishDefinition, 'ko'), /keyword details/);

const emptyTerm = koreanNote('');
assert.throws(() => context.validateSmartNote(emptyTerm, 'ko'), /keyword details/);

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(appSource, /generationError \? `<p class="note-error" role="alert">\$\{esc\(generationError\)\}<\/p>` : ''/);
assert.match(appSource, /<button class="button" data-review-action="generate-note">/);

console.log('Smart Note technical-keyword validation and visible error-state regressions passed.');
