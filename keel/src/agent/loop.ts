export interface AgentEvent {
  readonly type: "text" | "tool_call" | "tool_result" | "end";
}
