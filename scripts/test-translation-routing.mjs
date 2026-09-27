import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { phraseHintsForSttLanguage, sourceLanguageForStt, translationCacheKey } from '../src/language-routing.js';
import { GeminiTranslationAdapter } from '../src/services/index.js';
import { originalCaptionText, storeTranslationResult } from '../src/caption-state.js';

const course = { name: '데이터베이스' };
const glossary = [{ term: '알고리즘', aliases: ['algorithm'] }, { term: '네트워크', aliases: ['network'] }];

assert.deepEqual(phraseHintsForSttLanguage('en-US', course, glossary), ['algorithm', 'network']);
assert.deepEqual(phraseHintsForSttLanguage('ko-KR', course, glossary), ['데이터베이스', '알고리즘', 'algorithm', '네트워크', 'network']);
assert.equal(sourceLanguageForStt('en-US'), 'en');
assert.equal(sourceLanguageForStt('ko-KR'), 'ko');

const requests = [];
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  const segments = body.segments?.map(segment => ({ id: segment.id, correctedKorean: body.targetLanguage === 'ko' ? '한국어 자막' : segment.text, translatedText: body.targetLanguage === 'ko' ? '한국어 자막' : 'English subtitle' }));
  return { ok: true, json: async () => segments ? { segments } : { correctedKorean: body.targetLanguage === 'ko' ? '한국어 자막' : body.text, translatedText: body.targetLanguage === 'ko' ? '한국어 자막' : 'English subtitle' } };
};

const adapter = new GeminiTranslationAdapter({ endpoint: 'https://example.test/api/translate' });
const matrix = [
  { name: 'KO→EN', sourceLanguage: 'ko', targetLanguage: 'en', source: '한국어 원문', translation: 'English subtitle' },
  { name: 'EN→KO', sourceLanguage: 'en', targetLanguage: 'ko', source: 'English source', translation: '한국어 자막' },
  { name: 'KO→KO', sourceLanguage: 'ko', targetLanguage: 'ko', source: '한국어 원문', translation: '한국어 자막' },
  { name: 'EN→EN', sourceLanguage: 'en', targetLanguage: 'en', source: 'English source', translation: 'English subtitle' }
];

for (const entry of matrix) {
  await adapter.translate(entry.source, entry.targetLanguage, [], { sourceLanguage: entry.sourceLanguage });
  await adapter.translateSegments([{ id: `${entry.name}-segment`, content: entry.source }], entry.targetLanguage, [], { sourceLanguage: entry.sourceLanguage });
  const stored = storeTranslationResult({ content: entry.source, rawKorean: entry.source }, { correctedKorean: entry.translation, translatedText: entry.translation });
  assert.equal(originalCaptionText(stored), entry.source, `${entry.name} original caption must remain source language`);
  assert.equal(stored.translatedText, entry.translation, `${entry.name} translation caption must use target language`);
}

matrix.forEach((entry, index) => {
  const single = requests[index * 2];
  const batch = requests[index * 2 + 1];
  assert.deepEqual({ sourceLanguage: single.sourceLanguage, targetLanguage: single.targetLanguage, text: single.text }, { sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, text: entry.source });
  assert.deepEqual({ sourceLanguage: batch.sourceLanguage, targetLanguage: batch.targetLanguage, text: batch.segments[0].text }, { sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, text: entry.source });
});

assert.notEqual(translationCacheKey('ko', 'en', '같은 원문'), translationCacheKey('ko', 'ko', '같은 원문'));
assert.notEqual(translationCacheKey('en', 'ko', 'same source'), translationCacheKey('en', 'en', 'same source'));
assert.notEqual(translationCacheKey('ko', 'en', '같은 원문', 'single'), translationCacheKey('ko', 'en', '같은 원문', 'batch'));

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(serverSource, /The source transcript is English\. Translate it into natural Korean subtitle language\./);
assert.match(serverSource, /The source and target language are both \$\{target\}\. Do not translate or substitute another language\./);

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(appSource, /<option value="ko" \$\{translationTarget === 'ko' \? 'selected' : ''\}>Translate to Korean<\/option>/);
assert.match(appSource, /appendCaption\('original', text, 'interim'\)/);
assert.match(appSource, /appendCaption\('original', segment\.content, 'final', segment\.id\)/);
assert.doesNotMatch(appSource, /updateCaption\('original'/);
assert.match(appSource, /translatedText: source\.length \? String\(segment\.translatedText \|\| ''\)/);
assert.match(appSource, /sourceLanguage: sourceNote\.contentLanguage \|\| sourceNote\.sourceLanguage \|\| targetLanguage/);
assert.doesNotMatch(appSource, /chunkMap\.set\(item\.id, item\.text\)/);
assert.match(appSource, /const useMockStt = isDevelopment && requestedSttMode === 'mock';/);
assert.match(appSource, /const useMockTranslation = isDevelopment && requestedTranslationMode === 'mock';/);
assert.match(appSource, /const useMockChat = isDevelopment && new URLSearchParams\(location\.search\)\.get\('chat'\) === 'mock';/);

console.log('STT language routing and translation request language metadata passed.');
