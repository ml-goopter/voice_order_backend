/**
 * Estimate the LLM prompt-token cost of an ordering session.
 *
 * Runs the REAL prompt builders (`buildIntentPrompt`, `buildAgentSystemPrompt`,
 * `buildAgentUserMessage`) and the REAL `TOOL_SPECS`, assembles the exact payloads the
 * ordering agent sends over the wire (system prompt + tools array + per-turn user context +
 * tool results), and tokenizes each with the o200k_base encoding (GPT-4o/4.1/o-series).
 *
 * Two calls happen per turn (see src/ordering/graph/build-graph.ts):
 *   1. intent gate  — buildIntentPrompt → provider.complete()   (skipped when the previous
 *                     turn ended in an agent_reply; junk short-circuits before the agent)
 *   2. agent loop   — buildAgentMessages → provider.chat(); every chat() step RE-SENDS the
 *                     full system prompt + tools + accumulated scratchpad, so the fixed
 *                     overhead is billed once per step.
 *
 * The search_menu tool results here are ILLUSTRATIVE (real sizes depend on the live menu DB);
 * their SHAPES are accurate. Counts are content-only — real billing adds ~3-4 tok/message
 * envelope + tool-schema overhead (figure +5-8%). o200k_base ≈ OpenAI; Groq/Llama and Gemini
 * tokenize differently (±10-20%).
 *
 * Usage:
 *   npm i --no-save gpt-tokenizer        # tokenizer is not a project dependency
 *   npx tsx scripts/estimate-prompt-tokens.ts [outFile]
 *                                        # writes verbatim payloads to outFile
 *                                        # (default: ./prompts-full.txt); summary → stdout
 */
import { writeFileSync } from 'node:fs';
import { buildIntentPrompt } from '../src/llm/intent-prompt-builder.js';
import { buildAgentSystemPrompt, buildAgentUserMessage } from '../src/llm/agent-prompt-builder.js';
import { TOOL_SPECS } from '../src/ordering/tools/tool-specs.js';
import type { CartView, HistoryTurn } from '../src/contracts/cart-view.js';

// ---- tokenizer (optional dependency, loaded dynamically) ---------------------------------
let encode: (s: string) => number[];
try {
  // Default export is o200k_base (GPT-4o family).
  ({ encode } = await import('gpt-tokenizer'));
} catch {
  console.error('Missing tokenizer. Install it first (does not touch package.json):');
  console.error('  npm i -D  gpt-tokenizer');
  process.exit(1);
}
const tok = (s: string): number => encode(s).length;

// ---- what the provider actually puts on the wire ------------------------------------------
const AGENT_SYSTEM = buildAgentSystemPrompt();
const TOOLS_JSON = JSON.stringify(
  TOOL_SPECS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  null,
  2,
);

// ---- illustrative dynamic data (shapes accurate; sizes vary with the live menu) -----------
const emptyCart = (v: number): CartView => ({ cart_id: 'c_18f2a', pos_config_id: 2, version: v, items: [] });
const springRollLine = {
  line_id: 'L1', menu_item_key: 'mi_springroll', name: 'Spring Rolls (2pc)', quantity: 2,
  base_price_cents: 650, modifiers: [],
  available_modifiers: [{ modifier_key: 'mod_sweetchili', name: 'Sweet Chili', price_extra_cents: 0 }],
};
const padThaiLine = {
  line_id: 'L2', menu_item_key: 'mi_padthai', name: 'Pad Thai', quantity: 1,
  base_price_cents: 1450, modifiers: [],
  available_modifiers: [{ modifier_key: 'mod_nopeanut', name: 'No Peanuts', price_extra_cents: 0 }],
};
const cartAfterT1: CartView = { cart_id: 'c_18f2a', pos_config_id: 44, version: 1, items: [springRollLine] };
const cartAfterT3: CartView = { cart_id: 'c_18f2a', pos_config_id: 12, version: 2, items: [springRollLine, padThaiLine] };

const searchResultSpringRoll = JSON.stringify([
  { menu_item_key: 'mi_springroll', name: 'Spring Rolls (2pc)', base_price_cents: 650, available_modifiers: [{ modifier_key: 'mod_sweetchili', name: 'Sweet Chili', price_extra_cents: 0 }] },
]);
const searchResultPopular = JSON.stringify([
  { menu_item_key: 'mi_padthai', name: 'Pad Thai', base_price_cents: 1450, popularity: 'top', available_modifiers: [{ modifier_key: 'mod_nopeanut', name: 'No Peanuts', price_extra_cents: 0 }] },
  { menu_item_key: 'mi_greencurry', name: 'Green Curry', base_price_cents: 1600, popularity: 'popular', available_modifiers: [{ modifier_key: 'mod_extraspicy', name: 'Extra Spicy', price_extra_cents: 0 }] },
]);
const searchResultPadThai = JSON.stringify([
  { menu_item_key: 'mi_padthai', name: 'Pad Thai', base_price_cents: 1450, available_modifiers: [{ modifier_key: 'mod_nopeanut', name: 'No Peanuts', price_extra_cents: 0 }] },
]);

// ---- assemble the 5-turn session ----------------------------------------------------------
interface Payload { label: string; text: string; note?: boolean }
const out: Payload[] = [];
const push = (label: string, text: string, note = false) => out.push({ label, text, note });
const intent = (t: string) => { const p = buildIntentPrompt(t); return `SYSTEM:\n${p.system}\n\nUSER:\n${p.user}`; };

push('AGENT_SYSTEM (constant, every agent call)', AGENT_SYSTEM);
push('TOOLS array (constant, every agent call)', TOOLS_JSON);

// Turn 1: "Two spring rolls please" → search → propose
push('T1 intent', intent('Two spring rolls please'));
push('T1 agent user (step1)', buildAgentUserMessage({ customer_text: 'Two spring rolls please', current_cart: emptyCart(0), history: [] }));
push('T1 tool result: search_menu', searchResultSpringRoll);

// Turn 2: "What's good here?" → search(popularity) → spoken reply
const h2: HistoryTurn[] = [{ customer_text: 'Two spring rolls please' }];
push('T2 intent', intent("What's good here?"));
push('T2 agent user (step1)', buildAgentUserMessage({ customer_text: "What's good here?", current_cart: cartAfterT1, history: h2 }));
push('T2 tool result: search_menu(popularity)', searchResultPopular);

// Turn 3: "Yeah, add it" → intent SKIPPED (prev turn ended in agent_reply) → search → propose
const h3: HistoryTurn[] = [
  { customer_text: 'Two spring rolls please' },
  { customer_text: "What's good here?", agent_reply: 'Our Pad Thai is one of our most popular — want me to add it?' },
];
push('T3 intent', '(SKIPPED — previous turn ended in agent_reply; forced service, no LLM call)', true);
push('T3 agent user (step1)', buildAgentUserMessage({ customer_text: 'Yeah, add it', current_cart: cartAfterT1, history: h3 }));
push('T3 tool result: search_menu', searchResultPadThai);

// Turn 4: "No peanuts on the pad thai" → propose add_modifier directly (no search needed)
const h4: HistoryTurn[] = [...h3, { customer_text: 'Yeah, add it' }];
push('T4 intent', intent('No peanuts on the pad thai'));
push('T4 agent user (step1)', buildAgentUserMessage({ customer_text: 'No peanuts on the pad thai', current_cart: cartAfterT3, history: h4 }));

// Turn 5: junk → short-circuits, no agent call
push('T5 intent', intent("Haha thanks, how's your day going?"));
push('T5 agent', '(NONE — classified junk, short-circuits to END, no agent call, not recorded to history)', true);

// ---- write verbatim dump ------------------------------------------------------------------
const outFile = process.argv[2] ?? './prompts-full.txt';
let report = '';
for (const p of out) {
  const meta = p.note ? 'n/a' : `${tok(p.text)} tok, ${p.text.length} chars`;
  report += `\n${'='.repeat(90)}\n### ${p.label}   [${meta}]\n${'='.repeat(90)}\n${p.text}\n`;
}
writeFileSync(outFile, report);

// ---- cost roll-up -------------------------------------------------------------------------
const T = (label: string) => { const p = out.find((x) => x.label === label)!; return p.note ? 0 : tok(p.text); };
const sys = T('AGENT_SYSTEM (constant, every agent call)');
const tools = T('TOOLS array (constant, every agent call)');
const fixed = sys + tools; // re-sent on EVERY chat() step

console.log('\n===== PER-PAYLOAD TOKENS (o200k_base / GPT-4o family) =====');
for (const p of out) console.log(`${p.note ? '   n/a' : String(tok(p.text)).padStart(6)}  ${p.label}`);

console.log('\n===== CONSTANTS RE-SENT ON EVERY AGENT chat() STEP =====');
console.log(`  agent system prompt : ${sys} tok`);
console.log(`  tools array         : ${tools} tok`);
console.log(`  fixed agent overhead: ${fixed} tok  (billed once per step, per turn)`);

// Model the loop: each chat() re-sends system+tools+full scratchpad. steps[] = tool rounds after step1.
const TOOLCALL = 40; // approx assistant tool_call args (search/propose)
function agentTurnInput(userTok: number, toolResultToks: number[]): number {
  let scratch = fixed + userTok; // step-1 input
  let total = scratch;
  for (const r of toolResultToks) { scratch += TOOLCALL + r; total += scratch; } // each later chat() re-sends all
  return total;
}

const turns = [
  { n: 1, intent: T('T1 intent'), user: T('T1 agent user (step1)'), results: [T('T1 tool result: search_menu')] },
  { n: 2, intent: T('T2 intent'), user: T('T2 agent user (step1)'), results: [T('T2 tool result: search_menu(popularity)')] },
  { n: 3, intent: 0, user: T('T3 agent user (step1)'), results: [T('T3 tool result: search_menu')] },
  { n: 4, intent: T('T4 intent'), user: T('T4 agent user (step1)'), results: [] }, // propose straight away
  { n: 5, intent: T('T5 intent'), user: 0, results: [] }, // junk, no agent
];

console.log('\n===== INPUT (PROMPT) TOKENS PER TURN =====');
let grand = 0;
for (const t of turns) {
  const agent = t.n === 5 ? 0 : agentTurnInput(t.user, t.results);
  const total = t.intent + agent;
  grand += total;
  console.log(`  Turn ${t.n}: intent=${String(t.intent).padStart(4)}  agent(all chat steps)=${String(agent).padStart(6)}  => ${total} input tok`);
}
console.log(`\n  5-TURN TOTAL INPUT TOKENS (approx): ${grand}`);
console.log('  Output/completion tokens billed separately (~20-120 tok per agent step).');
console.log(`  Content-only counts; add ~5-8% for message-envelope + tool-schema overhead.`);
console.log(`\n  Verbatim payloads written to: ${outFile}`);
