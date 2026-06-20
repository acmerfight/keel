import type { ToolCall } from "../llm/types.ts";
import type { ToolConcurrency } from "../tools/builtin.ts";

export interface ScheduledToolCall {
  readonly toolCall: ToolCall;
  readonly concurrency: ToolConcurrency;
}

export type ParallelToolCallResult<Result> =
  | {
      readonly status: "fulfilled";
      readonly toolCall: ToolCall;
      readonly result: Result;
    }
  | {
      readonly status: "rejected";
      readonly toolCall: ToolCall;
      readonly reason: unknown;
    };

export interface ExecuteParallelToolCallsOptions<Result> {
  readonly toolCalls: readonly ScheduledToolCall[];
  readonly execute: (toolCall: ToolCall) => Promise<Result>;
}

export function canExecuteToolCallsInParallel(
  toolCalls: readonly ScheduledToolCall[],
): boolean {
  return toolCalls.every(
    ({ concurrency }) => concurrency.kind === "parallel-safe",
  );
}

export async function executeParallelToolCallsInSourceOrder<Result>(
  options: ExecuteParallelToolCallsOptions<Result>,
): Promise<readonly ParallelToolCallResult<Result>[]> {
  if (!canExecuteToolCallsInParallel(options.toolCalls)) {
    throw new Error("Cannot execute an exclusive tool call batch in parallel");
  }

  const settlements = await Promise.allSettled(
    options.toolCalls.map(({ toolCall }) => options.execute(toolCall)),
  );

  return settlements.map((settlement, index) => {
    const scheduled = options.toolCalls[index];
    /* v8 ignore next 3: Promise.allSettled preserves the input array length. */
    if (scheduled === undefined) {
      throw new Error("Missing scheduled tool call for parallel result");
    }
    if (settlement.status === "fulfilled") {
      return {
        status: "fulfilled",
        toolCall: scheduled.toolCall,
        result: settlement.value,
      };
    }
    return {
      status: "rejected",
      toolCall: scheduled.toolCall,
      reason: settlement.reason,
    };
  });
}
