/**
 * Приводит ответ к виду для сравнения: без регистра, «ё» как «е»,
 * без знаков препинания, ударений и пробелов («кресло качалка» = «Кресло-качалка»).
 */
export function normalizeAnswer(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isCorrect(answer: string, word: string): boolean {
  const normalized = normalizeAnswer(answer);
  return normalized !== '' && normalized === normalizeAnswer(word);
}
