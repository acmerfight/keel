import { describe, expect, test } from "vitest";
import {
  canExecuteToolCallsInParallel,
  executeParallelToolCallsInSourceOrder,
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
});
