/**
 * en_US-first display name from an Odoo translatable map (`{ en_US: "…", fr_FR: "…" }`), then any
 * available locale, then `fallback` when the map is null/empty. One rule so the many call sites that
 * pick a single-string name from a multi-locale map can't drift.
 */
export function displayName(names: Record<string, string> | null | undefined, fallback: string): string {
  if (!names) return fallback;
  return names.en_US ?? Object.values(names)[0] ?? fallback;
}
