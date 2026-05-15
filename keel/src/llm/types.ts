export interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LLMProvider {
  readonly id: string;
}
