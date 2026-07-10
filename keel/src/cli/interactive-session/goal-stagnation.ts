import { createHash } from "node:crypto";
import type { Message, ToolCall } from "../../llm/types.ts";

export interface GoalContinuationToolExecution {
  readonly toolCall: ToolCall;
  readonly ok: boolean;
  readonly bashExitCode?: number | null;
  readonly failedGoalVerification: boolean;
}

function compareKeys(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

function toolCallArgumentsFingerprint(toolCall: ToolCall): string {
  return JSON.stringify(
    Object.entries(toolCall)
      .filter(([name]) => name !== "id" && name !== "tool")
      .sort(([left], [right]) => compareKeys(left, right)),
  );
}

function latestToolResult(
  messages: readonly Message[],
  toolCallId: string,
): Extract<Message, { readonly role: "tool" }> | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "tool" && message.toolCallId === toolCallId) {
      return message;
    }
  }
  /* v8 ignore next -- completed prompt turns append every tool_end result before the end event; fail closed if that invariant changes. */
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function goalContinuationStagnationFingerprint(options: {
  readonly messages: readonly Message[];
  readonly toolExecutions: readonly GoalContinuationToolExecution[];
  readonly stateChanged: boolean;
}): string | null {
  // Bash is opaque to the runtime and may mutate the workspace even when its
  // output repeats. Only an exact, non-zero goal verification is already
  // treated by the goal runtime as verification evidence rather than mutation.
  const opaqueWorkspaceMutationPossible = options.toolExecutions.some(
    (execution) =>
      execution.ok &&
      execution.toolCall.tool === "bash" &&
      !execution.failedGoalVerification,
  );
  if (
    options.stateChanged ||
    options.toolExecutions.length === 0 ||
    opaqueWorkspaceMutationPossible
  ) {
    return null;
  }
  const signature: string[] = [];
  for (const execution of options.toolExecutions) {
    const result = latestToolResult(options.messages, execution.toolCall.id);
    /* v8 ignore next 3 -- latestToolResult is nullable only to preserve the fail-closed invariant guard above. */
    if (result === null) {
      return null;
    }
    signature.push(
      JSON.stringify([
        execution.toolCall.tool,
        toolCallArgumentsFingerprint(execution.toolCall),
        execution.ok,
        execution.bashExitCode ?? null,
        result.sourceTruncated === true,
        sha256(result.content),
      ]),
    );
  }
  return sha256(JSON.stringify(signature));
}
