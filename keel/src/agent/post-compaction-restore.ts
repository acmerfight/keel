import { isRecoverableToolErrorCode, KeelError } from "../core/error.ts";
import type { ReadResourceObservation } from "../core/resource-observation.ts";
import type { Message, ToolCall } from "../llm/types.ts";
import {
  executeToolCall,
  type ToolExecution,
  toolExecutionEffect,
} from "../tools/execution.ts";
import type { ProjectInstructionVisibilityState } from "../tools/scoped-project-instructions.ts";
import { resolveWorkspaceTarget } from "../tools/workspace-path.ts";
import {
  currentToolRound,
  isCompactedCurrentToolOutput,
} from "./context-compaction.ts";
import {
  clearReadVisibilityState,
  type ReadVisibilityState,
} from "./read-visibility.ts";
import { toolMessageSourceTruncationMetadata } from "./tool-output-artifacts.ts";

const POST_COMPACTION_MAX_RESTORED_FILES = 5;
const POST_COMPACTION_MAX_FILE_CHARS = 20_000;
const POST_COMPACTION_MAX_TOTAL_CHARS = 50_000;

interface RestoredPostCompactionRead {
  readonly toolCall: ToolCall;
  readonly execution: ToolExecution;
  readonly resourceObservation: ReadResourceObservation;
  readonly content: string;
  readonly complete: boolean;
}

interface RestoredPostCompactionProjectInstructions {
  readonly toolCall: ToolCall;
  readonly instructionPaths: readonly string[];
  readonly content: string;
  readonly complete: boolean;
}

interface ReadRestoreTarget {
  readonly targetPath: string;
  readonly offset?: number;
  readonly limit?: number;
}

function fitPostCompactionReadContent(
  content: string,
  maxChars: number,
): { readonly content: string; readonly complete: boolean } {
  if (content.length <= maxChars) {
    return { content, complete: true };
  }
  let omittedChars = content.length - maxChars;
  for (;;) {
    const marker = `\n\n[Post-compaction read snapshot truncated: omitted ${omittedChars} chars]`;
    if (marker.length >= maxChars) {
      return { content: marker.slice(0, maxChars), complete: false };
    }
    const prefixLength = maxChars - marker.length;
    const nextOmittedChars = content.length - prefixLength;
    if (nextOmittedChars === omittedChars) {
      return {
        content: `${content.slice(0, prefixLength)}${marker}`,
        complete: false,
      };
    }
    // Marker digit width depends on omittedChars, so settle to the exact count.
    omittedChars = nextOmittedChars;
  }
}

function currentCompactedReadToolCalls(
  messages: readonly Message[],
): readonly Extract<ToolCall, { readonly tool: "read" }>[] {
  const round = currentToolRound(messages);
  if (round === null) {
    return [];
  }

  const toolCallsById = new Map(
    round.toolRequest.toolCalls.map((toolCall) => [toolCall.id, toolCall]),
  );
  const compactedReadToolCalls: Extract<ToolCall, { readonly tool: "read" }>[] =
    [];
  for (const toolOutput of round.toolOutputs) {
    if (!isCompactedCurrentToolOutput(toolOutput.message.content)) {
      continue;
    }
    const toolCall = toolCallsById.get(toolOutput.message.toolCallId);
    if (toolCall?.tool === "read") {
      compactedReadToolCalls.push(toolCall);
    }
  }
  return compactedReadToolCalls;
}

function compactedReadRestoreTarget(
  workspace: string,
  toolCall: Extract<ToolCall, { readonly tool: "read" }>,
): ReadRestoreTarget | null {
  try {
    const target = resolveWorkspaceTarget(workspace, toolCall.path, "read");
    return {
      targetPath: target.targetPath,
      ...(toolCall.offset !== undefined ? { offset: toolCall.offset } : {}),
      ...(toolCall.limit !== undefined ? { limit: toolCall.limit } : {}),
    };
  } catch {
    return null;
  }
}

function compactedCurrentReadRestoreTargets(options: {
  readonly workspace: string;
  readonly messages: readonly Message[];
}): readonly ReadRestoreTarget[] {
  return currentCompactedReadToolCalls(options.messages).flatMap((toolCall) => {
    const target = compactedReadRestoreTarget(options.workspace, toolCall);
    return target === null ? [] : [target];
  });
}

function sameReadRestoreTarget(
  left: ReadRestoreTarget,
  right: ReadRestoreTarget,
): boolean {
  return (
    left.targetPath === right.targetPath &&
    left.offset === right.offset &&
    left.limit === right.limit
  );
}

function shouldSkipProjectInstructionRestore(error: unknown): boolean {
  return error instanceof KeelError && isRecoverableToolErrorCode(error.code);
}

function publishVisibleProjectInstructions(
  state: ProjectInstructionVisibilityState,
  executions: readonly ToolExecution[],
): void {
  for (const execution of executions) {
    const visibleInstructions = toolExecutionEffect(
      execution,
      "visible_project_instructions",
    );
    if (visibleInstructions === undefined) {
      continue;
    }
    state.markInstructionPathsVisible(visibleInstructions.instructionPaths);
  }
}

export async function restorePostCompactionReads(options: {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly hiddenWorkspacePaths?: readonly string[];
  readonly readVisibility: ReadVisibilityState;
  readonly projectInstructionVisibility: ProjectInstructionVisibilityState;
  readonly messages: Message[];
  readonly nextToolCallId: () => string;
}): Promise<void> {
  const hiddenWorkspacePaths = options.hiddenWorkspacePaths ?? [];
  const skippedReadTargets = compactedCurrentReadRestoreTargets({
    workspace: options.workspace,
    messages: options.messages,
  });
  const targetPaths = options.readVisibility
    .visibleReadsMostRecentFirst()
    .filter(
      (read) =>
        !skippedReadTargets.some((target) =>
          sameReadRestoreTarget(read, target),
        ),
    )
    .slice(0, POST_COMPACTION_MAX_RESTORED_FILES);
  const projectInstructionSnapshots =
    options.projectInstructionVisibility.visibleInstructionsMostRecentFirst();
  clearReadVisibilityState(options.readVisibility);
  options.projectInstructionVisibility.clear();
  const restoredProjectInstructions: RestoredPostCompactionProjectInstructions[] =
    [];
  const restored: RestoredPostCompactionRead[] = [];
  let totalChars = 0;

  for (const snapshot of projectInstructionSnapshots) {
    const remainingTotalChars = POST_COMPACTION_MAX_TOTAL_CHARS - totalChars;
    if (remainingTotalChars <= 0) {
      break;
    }
    let output: ReturnType<
      ProjectInstructionVisibilityState["formatRestoreOutput"]
    >;
    try {
      output =
        options.projectInstructionVisibility.formatRestoreOutput(snapshot);
    } catch (error) {
      if (!shouldSkipProjectInstructionRestore(error)) {
        throw error;
      }
      continue;
    }
    if (output === null) {
      continue;
    }
    const fittedContent = fitPostCompactionReadContent(
      output.content,
      Math.min(POST_COMPACTION_MAX_FILE_CHARS, remainingTotalChars),
    );
    totalChars += fittedContent.content.length;
    restoredProjectInstructions.push({
      toolCall: {
        id: options.nextToolCallId(),
        tool: "read",
        path: snapshot.relativePath,
      },
      instructionPaths: output.instructionPaths,
      content: fittedContent.content,
      complete: fittedContent.complete,
    });
  }
  for (const instruction of restoredProjectInstructions) {
    if (instruction.complete) {
      options.projectInstructionVisibility.markInstructionPathsVisible(
        instruction.instructionPaths,
      );
    }
  }

  for (const read of targetPaths) {
    const remainingTotalChars = POST_COMPACTION_MAX_TOTAL_CHARS - totalChars;
    if (remainingTotalChars <= 0) {
      break;
    }
    const toolCall: Extract<ToolCall, { readonly tool: "read" }> = {
      id: options.nextToolCallId(),
      tool: "read",
      path: read.targetPath,
      ...(read.offset !== undefined ? { offset: read.offset } : {}),
      ...(read.limit !== undefined ? { limit: read.limit } : {}),
    };
    const execution = await executeToolCall({
      workspace: options.workspace,
      toolCall,
      signal: options.signal,
      bash: { kind: "disabled" },
      hiddenWorkspacePaths,
      projectInstructions: options.projectInstructionVisibility,
    });
    if (!execution.ok) {
      continue;
    }
    const readEffect = execution.effects[0];
    const fittedContent = fitPostCompactionReadContent(
      execution.content,
      Math.min(POST_COMPACTION_MAX_FILE_CHARS, remainingTotalChars),
    );
    totalChars += fittedContent.content.length;
    restored.push({
      toolCall,
      execution,
      resourceObservation: readEffect.resourceObservation,
      content: fittedContent.content,
      complete: fittedContent.complete,
    });
  }

  if (restoredProjectInstructions.length === 0 && restored.length === 0) {
    return;
  }

  options.messages.push({
    role: "assistant",
    content: "",
    toolCalls: [
      ...restoredProjectInstructions.map((instruction) => instruction.toolCall),
      ...restored.map((read) => read.toolCall),
    ],
  });
  for (const instruction of restoredProjectInstructions) {
    options.messages.push({
      role: "tool",
      toolCallId: instruction.toolCall.id,
      content: instruction.content,
      ...toolMessageSourceTruncationMetadata({
        content: instruction.content,
        sourceTruncated: !instruction.complete,
      }),
    });
  }
  for (const read of restored) {
    options.messages.push({
      role: "tool",
      toolCallId: read.toolCall.id,
      content: read.content,
      ...toolMessageSourceTruncationMetadata({
        content: read.content,
        sourceTruncated:
          read.execution.sourceTruncated === true || !read.complete,
      }),
      resourceObservation: read.resourceObservation,
    });
  }
  options.readVisibility.applyVisibleToolExecutions(
    restored.filter((read) => read.complete).map((read) => read.execution),
  );
  publishVisibleProjectInstructions(
    options.projectInstructionVisibility,
    restored.filter((read) => read.complete).map((read) => read.execution),
  );
}
