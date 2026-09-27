import assert from 'node:assert/strict';
import { originalCaptionText, storeTranslationResult } from '../src/caption-state.js';

function verifyCaptionSeparation({ source, correctedKorean, translatedText }) {
  const segment = { id: 'segment-1', content: source, rawKorean: source, correctedKorean: '', translatedText: '' };
  const updated = storeTranslationResult(segment, { correctedKorean, translatedText });

  assert.equal(originalCaptionText(updated), source);
  assert.equal(updated.content, source);
  assert.equal(updated.rawKorean, source);
  assert.equal(updated.correctedKorean, correctedKorean);
  assert.equal(updated.translatedText, translatedText);
}

verifyCaptionSeparation({
  source: 'Today we will discuss linked lists.',
  correctedKorean: '오늘은 연결 리스트를 다루겠습니다.',
  translatedText: '오늘은 연결 리스트를 다루겠습니다.'
});

verifyCaptionSeparation({
  source: '오늘은 연결 리스트를 다루겠습니다.',
  correctedKorean: '오늘은 연결 리스트를 다루겠습니다.',
  translatedText: 'Today we will discuss linked lists.'
});

console.log('Caption source and translation state remain separated for EN→KO and KO→EN.');
