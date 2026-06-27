import type { ToolCall } from "../llm/types.ts";
import type { ToolConcurrency } from "../tools/tool-call.ts";

export const PARALLEL_TOOL_CALL_LIMIT = 10;

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

export type ToolCallExecutionSegment =
  | {
      readonly kind: "parallel";
      readonly toolCalls: readonly ScheduledToolCall[];
    }
  | {
      readonly kind: "single";
      readonly toolCall: ScheduledToolCall;
    };

interface IndexedParallelToolCallResult<Result> {
  readonly index: number;
  readonly result: ParallelToolCallResult<Result>;
}

export function canExecuteToolCallsInParallel(
  toolCalls: readonly ScheduledToolCall[],
): boolean {
  return toolCalls.every(
    ({ concurrency }) => concurrency.kind === "parallel-safe",
  );
}

export function planToolCallExecutionSegments(
  toolCalls: readonly ScheduledToolCall[],
): readonly ToolCallExecutionSegment[] {
  const segments: ToolCallExecutionSegment[] = [];
  let pendingParallelToolCalls: ScheduledToolCall[] = [];

  const flushPendingParallelToolCalls = (): void => {
    if (pendingParallelToolCalls.length > 1) {
      segments.push({
        kind: "parallel",
        toolCalls: pendingParallelToolCalls,
      });
    } else {
      for (const toolCall of pendingParallelToolCalls) {
        segments.push({
          kind: "single",
          toolCall,
        });
      }
    }
    pendingParallelToolCalls = [];
  };

  for (const toolCall of toolCalls) {
    if (toolCall.concurrency.kind === "parallel-safe") {
      pendingParallelToolCalls.push(toolCall);
      continue;
    }

    flushPendingParallelToolCalls();
    segments.push({
      kind: "single",
      toolCall,
    });
  }

  flushPendingParallelToolCalls();
  return segments;
}

export async function executeParallelToolCallsInSourceOrder<Result>(
  options: ExecuteParallelToolCallsOptions<Result>,
): Promise<readonly ParallelToolCallResult<Result>[]> {
  if (!canExecuteToolCallsInParallel(options.toolCalls)) {
    throw new Error("Cannot execute an exclusive tool call batch in parallel");
  }

  const results: IndexedParallelToolCallResult<Result>[] = [];
  let nextIndex = 0;

  const executeNext = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex++;
      const scheduled = options.toolCalls[index];
      if (scheduled === undefined) {
        return;
      }

      try {
        results.push({
          index,
          result: {
            status: "fulfilled",
            toolCall: scheduled.toolCall,
            result: await options.execute(scheduled.toolCall),
          },
        });
      } catch (reason) {
        results.push({
          index,
          result: {
            status: "rejected",
            toolCall: scheduled.toolCall,
            reason,
          },
        });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(PARALLEL_TOOL_CALL_LIMIT, options.toolCalls.length) },
      executeNext,
    ),
  );

  return results
    .sort((left, right) => left.index - right.index)
    .map(({ result }) => result);
}
