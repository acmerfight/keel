import { describe, expect, test } from "vitest";
import {
  canExecuteToolCallsInParallel,
  executeParallelToolCallsInSourceOrder,
  PARALLEL_TOOL_CALL_LIMIT,
  planToolCallExecutionSegments,
  type ScheduledToolCall,
} from "../../src/agent/tool-scheduler.ts";
import type { ToolCall } from "../../src/llm/types.ts";

class Deferred<T> {
  readonly promise: Promise<T>;

  private resolveValue: ((value: T) => void) | null = null;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveValue = resolve;
    });
  }

  resolve(value: T): void {
    if (this.resolveValue === null) {
      throw new Error("deferred promise resolver was not initialized");
    }
    this.resolveValue(value);
  }
}

const slowRead: ToolCall = {
  id: "slow_read",
  tool: "read",
  path: "slow.txt",
};

const fastRead: ToolCall = {
  id: "fast_read",
  tool: "read",
  path: "fast.txt",
};

const editCall: ToolCall = {
  id: "edit_note",
  tool: "edit",
  path: "note.txt",
  oldString: "before",
  newString: "after",
};

function readCall(index: number): ToolCall {
  return {
    id: `read_${index}`,
    tool: "read",
    path: `file-${index}.txt`,
  };
}

describe("tool scheduler", () => {
  test(`Given every scheduled tool call is parallel-safe,
    When a later call finishes before an earlier call,
    Then execution starts every call and returns results in source order`, async () => {
    const slow = new Deferred<string>();
    const fast = new Deferred<string>();
    const started: string[] = [];
    const completed: string[] = [];
    const scheduledToolCalls: readonly ScheduledToolCall[] = [
      { toolCall: slowRead, concurrency: { kind: "parallel-safe" } },
      { toolCall: fastRead, concurrency: { kind: "parallel-safe" } },
    ];

    const resultPromise = executeParallelToolCallsInSourceOrder({
      toolCalls: scheduledToolCalls,
      execute: async (toolCall) => {
        started.push(toolCall.id);
        if (toolCall.id === slowRead.id) {
          return await slow.promise;
        }
        if (toolCall.id === fastRead.id) {
          return await fast.promise;
        }
        throw new Error(`unexpected tool call ${toolCall.id}`);
      },
    });
    const completion = resultPromise.then(() => {
      completed.push("done");
    });

    await Promise.resolve();
    expect(started).toEqual(["slow_read", "fast_read"]);

    fast.resolve("fast result");
    await Promise.resolve();
    expect(completed).toEqual([]);

    slow.resolve("slow result");
    const results = await resultPromise;
    await completion;

    expect(results).toEqual([
      {
        status: "fulfilled",
        toolCall: slowRead,
        result: "slow result",
      },
      {
        status: "fulfilled",
        toolCall: fastRead,
        result: "fast result",
      },
    ]);
    expect(completed).toEqual(["done"]);
  });

  test(`Given more parallel-safe tool calls than the concurrency limit,
    When the scheduler executes the batch,
    Then it bounds active work while preserving source-order results`, async () => {
    const scheduledToolCalls: readonly ScheduledToolCall[] = Array.from(
      { length: PARALLEL_TOOL_CALL_LIMIT + 2 },
      (_, index) => ({
        toolCall: readCall(index),
        concurrency: { kind: "parallel-safe" },
      }),
    );
    let active = 0;
    let maxActive = 0;

    const results = await executeParallelToolCallsInSourceOrder({
      toolCalls: scheduledToolCalls,
      execute: async (toolCall) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return `${toolCall.id}:result`;
      },
    });

    expect(maxActive).toBe(PARALLEL_TOOL_CALL_LIMIT);
    expect(results).toEqual(
      scheduledToolCalls.map(({ toolCall }) => ({
        status: "fulfilled",
        toolCall,
        result: `${toolCall.id}:result`,
      })),
    );
  });

  test(`Given a scheduled tool batch contains an exclusive call,
    When the scheduler checks whether it can run in parallel,
    Then it keeps the batch out of the parallel path`, async () => {
    const scheduledToolCalls: readonly ScheduledToolCall[] = [
      { toolCall: slowRead, concurrency: { kind: "parallel-safe" } },
      {
        toolCall: editCall,
        concurrency: {
          kind: "exclusive",
          reason: "May mutate workspace files.",
        },
      },
    ];

    expect(canExecuteToolCallsInParallel(scheduledToolCalls)).toBe(false);
    await expect(
      executeParallelToolCallsInSourceOrder({
        toolCalls: scheduledToolCalls,
        execute: async () => "should not run",
      }),
    ).rejects.toThrow(
      "Cannot execute an exclusive tool call batch in parallel",
    );
  });

  test(`Given read-only calls surround exclusive barriers,
    When the scheduler plans execution segments,
    Then it batches adjacent reads and keeps lone calls on the direct path`, () => {
    const slowScheduled: ScheduledToolCall = {
      toolCall: slowRead,
      concurrency: { kind: "parallel-safe" },
    };
    const fastScheduled: ScheduledToolCall = {
      toolCall: fastRead,
      concurrency: { kind: "parallel-safe" },
    };
    const editScheduled: ScheduledToolCall = {
      toolCall: editCall,
      concurrency: {
        kind: "exclusive",
        reason: "May mutate workspace files.",
      },
    };
    const loneReadScheduled: ScheduledToolCall = {
      toolCall: readCall(1),
      concurrency: { kind: "parallel-safe" },
    };

    expect(
      planToolCallExecutionSegments([
        slowScheduled,
        fastScheduled,
        editScheduled,
        loneReadScheduled,
        editScheduled,
      ]),
    ).toEqual([
      { kind: "parallel", toolCalls: [slowScheduled, fastScheduled] },
      { kind: "single", toolCall: editScheduled },
      { kind: "single", toolCall: loneReadScheduled },
      { kind: "single", toolCall: editScheduled },
    ]);
  });
});
