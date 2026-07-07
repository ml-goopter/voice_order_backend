import type { z } from 'zod';

/**
 * Compact, human-readable rendering of a zod error — fed into the schema-repair
 * prompt (design §11.3 stages 2/3) so the LLM can fix its own output.
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length ? i.path.join('.') : '(root)';
      return `${path}: ${i.message}`;
    })
    .join('; ');
}
