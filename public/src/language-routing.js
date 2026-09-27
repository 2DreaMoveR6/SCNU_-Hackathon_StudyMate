export function sourceLanguageForStt(languageCode) {
  return /^en(?:-|$)/i.test(String(languageCode || '')) ? 'en' : 'ko';
}

export function phraseHintsForSttLanguage(languageCode, course, entries = []) {
  const hints = [course?.name, ...entries.flatMap(entry => [entry.term, ...(entry.aliases || [])])]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const languageHints = sourceLanguageForStt(languageCode) === 'en' ? hints.filter(hint => /^[\x00-\x7F]+$/.test(hint)) : hints;
  return [...new Set(languageHints)].slice(0, 20);
}

export function translationCacheKey(sourceLanguage, targetLanguage, contents, mode = 'single') {
  const text = Array.isArray(contents) ? contents : [contents];
  return `${sourceLanguage}:${targetLanguage}:${mode}:${text.map(value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()).join('|')}`;
}
