/** Normalize a raw final transcript before matching/parsing (design §6). */
export function normalizeTranscript(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
