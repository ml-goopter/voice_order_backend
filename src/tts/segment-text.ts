/**
 * Split a spoken reply into ordered, speakable segments (≈ one sentence each) so each can be
 * synthesized into its own standalone mp3 and streamed the moment it is ready — the client plays
 * segment 1 while segment 2 is still synthesizing (progressive playback, low time-to-first-audio).
 *
 * Splitting is on sentence-ending punctuation followed by whitespace, so a decimal or price
 * ("$2.50") — whose `.` has no trailing space — stays intact. Abbreviations ("Mr.") are rare in
 * agent replies and would at worst produce an extra short segment, which is harmless.
 */

/** Hard cap so one long, punctuation-free clause still breaks into playable pieces. */
const MAX_CHARS = 160;

export function segmentText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_CHARS) {
      segments.push(sentence);
      continue;
    }
    // Over-long sentence: break on the last space before the cap (fall back to a hard cut).
    let rest = sentence;
    while (rest.length > MAX_CHARS) {
      const space = rest.lastIndexOf(' ', MAX_CHARS);
      const cut = space > 0 ? space : MAX_CHARS;
      segments.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) segments.push(rest);
  }
  return segments;
}
