import type { ToolCall, Usage } from "../llm/types.ts";
import type { ContextCompactionStats } from "./context-compaction.ts";
import type {
  ToolOutputArtifactSourceStatus,
  ToolOutputArtifactToolName,
} from "./tool-output-artifacts.ts";

export interface CostReport {
  readonly spentUsd: number;
  readonly maxUsd?: number;
  readonly budgetExceeded: boolean;
}

type ContextCompactionReason = "proactive" | "overflow_recovery";

// stopReason is "completed" when the assistant finished with a plain answer;
// otherwise it is the stop policy's reason label (e.g. "cost_budget",
// "repeated_tool_call", "turn_limit").
export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | ({
      readonly type: "context_compacted";
      readonly reason: ContextCompactionReason;
    } & ContextCompactionStats)
  | {
      readonly type: "provider_retry";
      readonly provider: string;
      readonly reason: string;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
    }
  | { readonly type: "tool_start"; readonly toolCall: ToolCall }
  | {
      readonly type: "tool_end";
      readonly toolCall: ToolCall;
      readonly ok: boolean;
    }
  | {
      readonly type: "tool_output_artifact";
      readonly status: "stored";
      readonly ref: string;
      readonly toolCallId: string;
      readonly toolName: ToolOutputArtifactToolName;
      readonly sourceStatus: ToolOutputArtifactSourceStatus;
      readonly omittedChars: number;
    }
  | {
      readonly type: "tool_output_artifact";
      readonly status: "failed";
      readonly reason: string;
      readonly toolCallId: string;
      readonly toolName: ToolOutputArtifactToolName;
      readonly omittedChars: number;
    }
  | {
      readonly type: "end";
      readonly usage: Usage;
      readonly turns: number;
      readonly stopReason: string;
      readonly cost?: CostReport;
    };
