export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export type LLMEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "stop"; readonly usage: Usage };

export interface StreamOptions {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly signal: AbortSignal;
}

export interface LLMProvider {
  readonly id: string;
  readonly stream: (options: StreamOptions) => AsyncIterable<LLMEvent>;
}
