export interface LlmPrompt {
  system: string;
  user: string;
}

/** Cloud LLM abstraction (Groq / OpenAI / Gemini, design §8/§14). Returns strict JSON text. */
export interface LlmProvider {
  readonly name: string;
  complete(prompt: LlmPrompt): Promise<string>;
}
