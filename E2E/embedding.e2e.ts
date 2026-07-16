/**
 * Real-stack e2e for the pipeline triggered on `stt.final_transcript.received`,
 * scoped to the Order Understanding module only — up to the LLM output.
 *
 * Trigger:  emit the event on a real EventBus (the true pipeline entry — where STT
 *           hands off; see voice/voice-message-handler.ts).
 * Stack:    LIVE Postgres/pgvector (real Jade Garden menu in `item_vector` + Odoo
 *           JOINs for the KNN candidate path), LIVE Jina query embeddings (real
 *           vector retrieval), and a LIVE Ollama LLM. Nothing is mocked; the wiring
 *           mirrors app.ts minus the Cart module, voice/realtime/WS.
 * Assert:   the operations proposed by Order Understanding (via `order.operations_proposed`)
 *           — i.e. the LLM output. Cart application (applying the proposal to Redis) is out
 *           of scope here; it is covered by the Cart module's own tests.
 *
 * The LLM is real and non-deterministic, and the menu has many near-duplicate items
 * (lunch/dinner variants, 3 "Combination For One", etc.), so:
 *   - assertions are tolerant — the added item's NAME must match the ordered dish
 *     (any variant) with the right quantity, not a specific menu_item_key;
 *   - the clarification tests use input that maps to several distinct items and
 *     SELF-SKIP (not fail) when the model happens to resolve without asking;
 *   - the parse-failure branch cannot be forced with a compliant JSON-returning
 *     model, so it is skipped here and covered deterministically in
 *     order-understanding-service.test.ts.
 *
 * Prereqs (self-checked in beforeAll; the suite skips if missing):
 *   - Postgres/pgvector at ODOO_DATABASE_URL, with pos_config_id 1's `item_vector`
 *     rows seeded (npm run seed:menu:pg) and the Odoo menu tables present.
 *   - Ollama at LLM_BASE_URL serving LLM_MODEL (default qwen3:14b).
 *   - JINA_API_KEY for query embeddings (EMBEDDING_PROVIDER=jina).
 * Run with: npm run test:e2e   (see vitest.e2e.config.ts)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../src/config/env.js';
import { EventBus } from '../src/events/event-bus.js';
import { MenuService } from '../src/menu/menu-service.js';
import { PostgresMenuStore } from '../src/menu/postgres-menu-store.js';

const { Pool } = pg;

const POS = 1;


// ---- live pipeline (built once in beforeAll) --------------------------------
let pool: pg.Pool;
let menu: MenuService;
let bus: EventBus;
let infraReady = false;
let infraSkipReason = '';
const createdCartIds: string[] = [];
const subs: Array<() => void> = [];

// ---- per-test timing (reported in afterAll with the model name) -------------
// Only tests that actually ran the live pipeline are timed; when infra is absent
// every test skips instantly, so there is nothing meaningful to average.
const durations: Array<{ name: string; ms: number }> = [];
let testStart = 0;

// ---- LLM exchange recorder (debug: dump full prompt/response on a failed test) ----
// The live provider is wrapped so every complete() call is captured in order. On failure
// afterEach prints the exchanges for that test's cart(s) — the raw prompts (including the
// resume `clarification: { question, answer }`) and the model's replies — which is what you
// need to see WHY a turn re-asked or mis-parsed. Filtering is by cart_id, which appears in
// each prompt's user JSON (current_cart.cart_id).
interface LlmExchange {
    system: string;
    user: string;
    response?: string;
    error?: string;
}
const llmLog: LlmExchange[] = [];


// ---- setup / teardown -------------------------------------------------------

beforeAll(async () => {
    pool = new Pool({ connectionString: config.odooDatabaseUrl });

    // Preflight: Postgres/pgvector reachable and seeded with pos 1's item_vector
    // rows, Jina key present. Skip (don't fail) the whole suite if it isn't there.
    try {
        const { rows } = await pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM item_vector WHERE pos_config_id = $1',
            [POS],
        );
        if ((rows[0]?.n ?? 0) === 0) {
            infraSkipReason = `Postgres has no item_vector rows for pos ${POS} (run npm run seed:menu:pg)`;
            return;
        }
        if (config.embeddingProvider === 'jina' && !config.jinaApiKey) {
            infraSkipReason = 'EMBEDDING_PROVIDER=jina but JINA_API_KEY is empty';
            return;
        }
    } catch (err) {
        infraSkipReason = `Postgres not reachable at ${config.odooDatabaseUrl} (or item_vector missing): ${(err as Error).message}`;
        return;
    }

    // The Candidate Matcher (KNN vector search) is all this inspector exercises.
    menu = new MenuService(new PostgresMenuStore(pool));
    bus = new EventBus();

    infraReady = true;
});

beforeEach(() => {
    testStart = Date.now();
});


afterAll(async () => {
    if (durations.length > 0) {
        const total = durations.reduce((sum, d) => sum + d.ms, 0);
        const avg = Math.round(total / durations.length);
        const lines = [
            `\n[llm_pipeline.e2e] model=${config.llmModel} provider=${config.llmProvider}`,
            ...durations.map((d) => `  ${String(d.ms).padStart(7)} ms  ${d.name}`),
            `  average: ${avg} ms over ${durations.length} test(s)\n`,
        ];
        // Write straight to stdout: the vitest reporter does not surface console.* from afterAll.
        process.stdout.write(lines.join('\n') + '\n');
    }
    if (pool) await pool.end();
});

// ---- candidate inspector ----------------------------------------------------
// A quick way to SEE what the Candidate Matcher (KNN vector search) surfaces for a
// given transcript. Override the query with QUERY="..." on the command line, e.g.
//   QUERY="two spring rolls and a coke" npm run test:e2e -- embedding
describe('Embedding — candidate inspector', () => {
    it('fetches and prints candidates for a transcript', async () => {
        if (!infraReady) {
            console.log(`[embedding.e2e] SKIP: ${infraSkipReason}`);
            return;
        }

        const query = process.env.QUERY ?? 'What would you suggest? Give me some suggestions';
        const { items } = await menu.searchMenu(POS, { query });

        const lines = [
            `[embedding.e2e] query=${JSON.stringify(query)} → ${items.length} candidate(s)`,
            ...items.map((c, i) => {
                const score = c.score !== undefined ? c.score.toFixed(4) : '  n/a ';
                const matched = c.matched_text ? `  matched=${JSON.stringify(c.matched_text)}` : '';
                return `  ${String(i + 1).padStart(2)}. [${score}] ${c.name}  (key=${c.menu_item_key}, mods=${c.available_modifiers.length})${matched}`;
            }),
        ];
        const text = lines.join('\n') + '\n';

        // Print to stdout AND persist to a file — the vitest reporter does not reliably
        // surface in-test console output, so the file is the durable record.
        process.stdout.write('\n' + text + '\n');
        const outPath = new URL('./candidates.output.txt', import.meta.url);
        writeFileSync(outPath, text + '\n' + JSON.stringify(items, null, 2) + '\n');
        process.stdout.write(`[embedding.e2e] wrote candidates to ${outPath.pathname}\n`);

        expect(Array.isArray(items)).toBe(true);
    });
});