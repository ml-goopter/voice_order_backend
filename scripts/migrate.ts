/**
 * Apply src/db/schema/*.sql in order. Stub: prints the plan.
 * TODO: `npm i pg`, connect with DATABASE_URL, execute each file in a transaction.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'src', 'db', 'schema');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

console.log('Would apply migrations in order:');
for (const f of files) console.log('  •', f);
console.log('\n(stub — wire pg to actually run these)');
