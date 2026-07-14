export interface LlmPrompt {
  system: string;
  user: string;
}

/** One tool the agent may call, advertised to the model (native OpenAI `tools`). `parameters`
 *  is a JSON Schema object describing the tool's arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** A tool call the model asked for. `arguments` is the PARSED JSON object (not the raw string
 *  the provider returns); the caller validates it against the tool's own zod schema. `raw` is the
 *  provider's ORIGINAL, opaque tool-call payload — kept so the assistant turn can be replayed
 *  VERBATIM on the next loop iteration. Some providers (e.g. Gemini) attach fields to a tool call
 *  (a `thought_signature`) that MUST be echoed back unchanged or the follow-up request 400s;
 *  rebuilding the call from `id`/`name`/`arguments` alone drops them. Only the provider that
 *  produced a `raw` reads it; it stays opaque to the rest of the system. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  raw?: unknown;
}

/** The agent's turn-scoped scratchpad transcript, mapped 1:1 onto OpenAI chat messages. */
export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** One assistant turn: prose (`text`) and/or the tool calls it wants run. `toolCalls` is always
 *  present (empty when the model only replied with prose). */
export interface ChatResult {
  text?: string;
  toolCalls: ToolCall[];
}

/** Cloud LLM abstraction (Groq / OpenAI / Gemini, design §8/§14). `complete` returns strict JSON
 *  text (parser/classifier); `chat` drives the tool-calling agent loop (see docs/agent-tools.md). */
export interface LlmProvider {
  readonly name: string;
  complete(prompt: LlmPrompt): Promise<string>;
  chat(messages: AgentMessage[], tools: ToolSpec[]): Promise<ChatResult>;
}
