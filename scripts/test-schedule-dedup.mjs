import assert from 'node:assert/strict';
import { extractLocalScheduleCandidates, filterPendingScheduleCandidates } from '../src/services/index.js';

const context = { id: 'lecture-1', recordedAt: '2026-09-19T10:00:00+09:00', course: 'Database' };
const repeated = extractLocalScheduleCandidates([
  { id: 'segment-1', content: '9월 25일까지 데이터베이스 과제를 제출하세요.' },
  { id: 'segment-2', content: '9월 25일까지 데이터베이스 과제를 제출하세요.' }
], context);

assert.equal(repeated.length, 1, 'Repeated transcript content must create one candidate.');
const distinct = extractLocalScheduleCandidates([
  { id: 'segment-1', content: '9월 25일까지 데이터베이스 과제를 제출하세요.' },
  { id: 'segment-2', content: '10월 2일에 중간고사를 보겠습니다.' }
], context);
assert.equal(distinct.length, 2, 'Different schedule names or dates must remain separate.');
assert.equal(filterPendingScheduleCandidates([...repeated, ...repeated], [], []).length, 1, 'Existing identical candidates must be deduplicated.');
const confirmed = { sourceCandidateId: repeated[0].id, candidateFingerprint: repeated[0].candidateFingerprint };
assert.equal(filterPendingScheduleCandidates(repeated, [confirmed], []).length, 0, 'A confirmed candidate must not reappear.');

console.log('Schedule candidate deduplication passed.');
