export function originalCaptionText(segment) {
  return String(segment?.content || segment?.rawKorean || '').trim();
}

export function storeTranslationResult(segment, result) {
  return {
    ...segment,
    correctedKorean: String(result?.correctedKorean || '').trim(),
    translatedText: String(result?.translatedText || '').trim()
  };
}
