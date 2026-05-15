export interface LLMEvent {
  readonly type: "text" | "tool_call" | "stop";
}
