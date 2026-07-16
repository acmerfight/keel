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
  // completed prompt turns append every tool_end result before the end event; fail closed if that invariant changes.
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentTurnMessages(messages: readonly Message[]): readonly Message[] {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  return messages.slice(lastUserIndex + 1);
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
  if (options.stateChanged || opaqueWorkspaceMutationPossible) {
    return null;
  }
  if (options.toolExecutions.length === 0) {
    const turnMessages = currentTurnMessages(options.messages);
    const toolEvidencePresent = turnMessages.some(
      (message) =>
        message.role === "tool" ||
        (message.role === "assistant" && message.toolCalls.length > 0),
    );
    if (toolEvidencePresent) {
      return null;
    }
    return `text:${sha256(
      JSON.stringify(
        turnMessages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content),
      ),
    )}`;
  }
  const signature: string[] = [];
  for (const execution of options.toolExecutions) {
    const result = latestToolResult(options.messages, execution.toolCall.id);
    // latestToolResult is nullable only to preserve the fail-closed invariant guard above.
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
  return `tools:${sha256(JSON.stringify(signature))}`;
}

export interface RepeatedGoalContinuationPattern {
  readonly key: string;
  readonly fingerprints: readonly string[];
}

export function repeatedGoalContinuationPattern(options: {
  readonly fingerprints: readonly string[];
  readonly repetitionLimit: number;
  readonly maxPatternLength: number;
}): RepeatedGoalContinuationPattern | null {
  for (
    let patternLength = 1;
    patternLength <= options.maxPatternLength;
    patternLength++
  ) {
    const requiredFingerprints = patternLength * options.repetitionLimit;
    if (options.fingerprints.length < requiredFingerprints) {
      continue;
    }
    const repeatedSuffix = options.fingerprints.slice(-requiredFingerprints);
    if (
      repeatedSuffix.every(
        (fingerprint, index) =>
          fingerprint === repeatedSuffix[index % patternLength],
      )
    ) {
      const pattern = repeatedSuffix.slice(0, patternLength);
      const canonicalFingerprints = pattern
        .map((_, index) => [
          ...pattern.slice(index),
          ...pattern.slice(0, index),
        ])
        .reduce((left, right) =>
          compareKeys(JSON.stringify(left), JSON.stringify(right)) <= 0
            ? left
            : right,
        );
      return {
        key: JSON.stringify(canonicalFingerprints),
        fingerprints: canonicalFingerprints,
      };
    }
  }
  return null;
}
