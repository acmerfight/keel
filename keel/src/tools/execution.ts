import {
  errorMessage,
  isAbortThrow,
  isRecoverableToolErrorCode,
  KeelError,
  type RecoverableToolErrorCode,
} from "../core/error.ts";
import type { RecordLastBatchCheckpointOperation } from "../core/git.ts";
import {
  copySessionGoal,
  formatSessionGoalCompletedToolResult,
  normalizeSessionGoalCompletionCommand,
  type SessionGoal,
} from "../core/session-goal.ts";
import {
  formatSessionTaskProgressToolResult,
  type SessionTaskProgress,
  sessionTaskProgressFromPlan,
} from "../core/task-progress.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeApplyPatch } from "./apply-patch.ts";
import { executeBash } from "./bash.ts";
import { executeEdit } from "./edit.ts";
import { executeGitDiff } from "./git-diff.ts";
import { executeGitStatus } from "./git-status.ts";
import { executeGlob } from "./glob.ts";
import { executeGrep } from "./grep.ts";
import { executeLs } from "./ls.ts";
import { executeRead } from "./read.ts";
import type { ProjectInstructionVisibilityState } from "./scoped-project-instructions.ts";
import { ScopedProjectInstructionsNotVisibleError } from "./scoped-project-instructions.ts";
import {
  builtinToolCallSchema,
  type InvalidToolCall,
  isInvalidToolCall,
  type ToolCall,
  type ValidToolCall,
} from "./tool-call.ts";
import { invalidBuiltinToolCallError } from "./tool-error.ts";
import type { ToolResult } from "./types.ts";
import {
  resolveWorkspaceCreateTarget,
  resolveWorkspaceTarget,
} from "./workspace-path.ts";
import { executeWrite } from "./write.ts";

type ReadToolCall = Extract<ValidToolCall, { readonly tool: "read" }>;
type LsToolCall = Extract<ValidToolCall, { readonly tool: "ls" }>;
type GlobToolCall = Extract<ValidToolCall, { readonly tool: "glob" }>;
type GrepToolCall = Extract<ValidToolCall, { readonly tool: "grep" }>;
type GitStatusToolCall = Extract<
  ValidToolCall,
  { readonly tool: "git_status" }
>;
type GitDiffToolCall = Extract<ValidToolCall, { readonly tool: "git_diff" }>;
type EditToolCall = Extract<ValidToolCall, { readonly tool: "edit" }>;
type WriteToolCall = Extract<ValidToolCall, { readonly tool: "write" }>;
type ApplyPatchToolCall = Extract<
  ValidToolCall,
  { readonly tool: "apply_patch" }
>;
type BashToolCall = Extract<ValidToolCall, { readonly tool: "bash" }>;
type UpdatePlanToolCall = Extract<
  ValidToolCall,
  { readonly tool: "update_plan" }
>;
type UpdateGoalToolCall = Extract<
  ValidToolCall,
  { readonly tool: "update_goal" }
>;

interface BuiltinToolExecutionContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly recordCheckpoints?: boolean;
  readonly bashPermission?: BashPermissionPolicy;
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
  readonly projectInstructions?: ProjectInstructionVisibilityState;
  readonly sessionGoal?: SessionGoal;
  readonly goalCompletionCommandEvidence?: GoalCompletionCommandEvidence;
  readonly workspaceMutationSequence?: number;
}

interface BashCommandEvidence {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
}

export interface GoalCompletionCommandEvidence {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly observedMutationSequence: number;
}

export interface ToolExecution {
  readonly content: string;
  readonly ok: boolean;
  readonly sourceTruncated?: boolean;
  readonly artifactContent?: string;
  readonly artifactSourceTruncated?: boolean;
  readonly readTargetPath?: string;
  readonly readTargetOffset?: number;
  readonly readTargetLimit?: number;
  readonly mutatedTargetPath?: string;
  readonly mutatedTargetPaths?: readonly string[];
  readonly visibleProjectInstructionPaths?: readonly string[];
  readonly checkpointOperations?: readonly RecordLastBatchCheckpointOperation[];
  readonly taskProgressUpdate?: SessionTaskProgress;
  readonly sessionGoalUpdate?: SessionGoal;
  readonly bashCommandEvidence?: BashCommandEvidence;
}

export interface ExecuteToolCallOptions extends BuiltinToolExecutionContext {
  readonly toolCall: ToolCall;
}

function sourceTruncation(result: ToolResult): {
  readonly sourceTruncated?: true;
  readonly artifactContent?: string;
  readonly artifactSourceTruncated?: boolean;
} {
  return {
    ...(result.sourceTruncated === true ? { sourceTruncated: true } : {}),
    ...(result.artifactContent !== undefined
      ? { artifactContent: result.artifactContent }
      : {}),
    ...(result.artifactSourceTruncated !== undefined
      ? { artifactSourceTruncated: result.artifactSourceTruncated }
      : {}),
  };
}

interface RecoverableToolError extends KeelError {
  readonly code: RecoverableToolErrorCode;
  readonly recovery: string;
}

function disabledBashMessage(): string {
  return "Tool failed: bash failed: shell commands are disabled. Re-run with --bash-policy ask, --bash-policy trusted, or --allow-bash to enable them.";
}

function deniedBashMessage(message: string): string {
  return `Tool failed: bash permission denied: ${message}\nRecovery: Ask the user for permission or choose a non-shell approach.`;
}

function isRecoverableToolError(error: unknown): error is RecoverableToolError {
  return error instanceof KeelError && isRecoverableToolErrorCode(error.code);
}

function toolFailureMessage(error: RecoverableToolError): string {
  return `Tool failed: ${error.message}\nRecovery: ${error.recovery}`;
}

function unhandledToolFailureMessage(
  toolName: ToolCall["tool"],
  error: unknown,
): string {
  if (error instanceof KeelError && error.recovery !== undefined) {
    return `Tool failed: ${error.message}\nRecovery: ${error.recovery}`;
  }

  const message = errorMessage(error);
  const toolPrefix = `${toolName} failed:`;
  const toolMessage = message.startsWith(toolPrefix)
    ? message
    : `${toolPrefix} ${message}`;
  return `Tool failed: ${toolMessage}\nRecovery: Inspect the failed tool request and current workspace state, then retry with corrected arguments or choose another approach.`;
}

function invalidToolCallFailureMessage(toolCall: InvalidToolCall): string {
  return `Tool failed: ${toolCall.tool} failed: invalid arguments: ${toolCall.validationError}\nRecovery: ${toolCall.recovery}`;
}

function scopedProjectInstructionsFailureMessage(
  error: ScopedProjectInstructionsNotVisibleError,
): string {
  return `Tool failed: ${error.message}\nRecovery: ${error.recovery}`;
}

function executeUpdatePlanTool(toolCall: UpdatePlanToolCall): ToolExecution {
  const taskProgress = sessionTaskProgressFromPlan(toolCall.plan);
  return {
    content: formatSessionTaskProgressToolResult(taskProgress),
    ok: true,
    taskProgressUpdate: taskProgress,
  };
}

function executeUpdateGoalTool(
  {
    workspace,
    allowBash,
    sessionGoal,
    goalCompletionCommandEvidence,
    workspaceMutationSequence,
  }: BuiltinToolExecutionContext,
  toolCall: UpdateGoalToolCall,
): ToolExecution {
  if (sessionGoal?.status !== "active") {
    return {
      content:
        "Tool failed: update_goal failed: no active session goal is set.\nRecovery: Continue without updating the goal, or ask the user to set a saved session goal first.",
      ok: false,
    };
  }
  if (sessionGoal.completionCommand === undefined) {
    return {
      content:
        "Tool failed: update_goal failed: no completion command is set for the active session goal.\nRecovery: Ask the user to add one with /goal verify <command>, continue working, or ask the user to use /goal complete for an explicit override.",
      ok: false,
    };
  }
  const expectedCommand = normalizeSessionGoalCompletionCommand(
    sessionGoal.completionCommand,
  );
  if (goalCompletionCommandEvidence === undefined) {
    return {
      content:
        `Tool failed: update_goal failed: completion command has not run for the active session goal.\n` +
        (allowBash
          ? `Recovery: Run bash with "${expectedCommand}" after finishing the work, then call update_goal again if it exits 0.`
          : `Recovery: Bash is disabled in this run, so the agent cannot run "${expectedCommand}". Ask the user to resume with --bash-policy ask or --bash-policy trusted, or to use /goal complete after checking it manually.`),
      ok: false,
    };
  }
  const actualCommand = normalizeSessionGoalCompletionCommand(
    goalCompletionCommandEvidence.command,
  );
  if (actualCommand !== expectedCommand) {
    return {
      content: `Tool failed: update_goal failed: latest command evidence does not match the goal completion command.\nRecovery: Run bash with "${expectedCommand}" after finishing the work, then call update_goal again if it exits 0.`,
      ok: false,
    };
  }
  if (goalCompletionCommandEvidence.cwd !== workspace) {
    return {
      content: `Tool failed: update_goal failed: latest command evidence came from a different working directory.\nRecovery: Run bash with "${expectedCommand}" in the current workspace, then call update_goal again if it exits 0.`,
      ok: false,
    };
  }
  if (goalCompletionCommandEvidence.exitCode !== 0) {
    return {
      content: `Tool failed: update_goal failed: completion command exited with code ${goalCompletionCommandEvidence.exitCode ?? "unknown"}.\nRecovery: Fix the failing verification, rerun "${expectedCommand}", then call update_goal again if it exits 0.`,
      ok: false,
    };
  }
  if (
    goalCompletionCommandEvidence.observedMutationSequence !==
    (workspaceMutationSequence ?? 0)
  ) {
    return {
      content:
        `Tool failed: update_goal failed: completion command evidence is stale because the workspace changed after it ran.\n` +
        `Recovery: Rerun bash with "${expectedCommand}" after the latest mutation, then call update_goal again if it exits 0.`,
      ok: false,
    };
  }
  const completedGoal: SessionGoal = {
    objective: sessionGoal.objective,
    status: toolCall.status,
    completionCommand: sessionGoal.completionCommand,
  };
  return {
    content: formatSessionGoalCompletedToolResult(completedGoal),
    ok: true,
    sessionGoalUpdate: copySessionGoal(completedGoal),
  };
}

function executeReadTool(
  { workspace, projectInstructions }: BuiltinToolExecutionContext,
  toolCall: ReadToolCall,
): ToolExecution {
  const result = executeRead(workspace, toolCall.path, {
    offset: toolCall.offset,
    limit: toolCall.limit,
  });
  const scopedOutput = projectInstructions?.formatReadOutput(
    result.targetPath,
    result.content,
  );
  return {
    content: scopedOutput?.content ?? result.content,
    ok: true,
    ...sourceTruncation(result),
    readTargetPath: result.targetPath,
    ...(scopedOutput !== undefined && scopedOutput.instructionPaths.length > 0
      ? { visibleProjectInstructionPaths: scopedOutput.instructionPaths }
      : {}),
    ...(toolCall.offset !== undefined
      ? { readTargetOffset: toolCall.offset }
      : {}),
    ...(toolCall.limit !== undefined
      ? { readTargetLimit: toolCall.limit }
      : {}),
  };
}

function executeLsTool(
  { workspace }: BuiltinToolExecutionContext,
  toolCall: LsToolCall,
): ToolExecution {
  const result = executeLs(workspace, {
    ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
    ...(toolCall.limit !== undefined ? { limit: toolCall.limit } : {}),
  });
  return {
    content: result.content,
    ok: true,
    ...sourceTruncation(result),
  };
}

async function executeGlobTool(
  { workspace, signal }: BuiltinToolExecutionContext,
  toolCall: GlobToolCall,
): Promise<ToolExecution> {
  const result = await executeGlob(workspace, toolCall.pattern, {
    ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
    signal,
  });
  return {
    content: result.content,
    ok: true,
    ...sourceTruncation(result),
  };
}

async function executeGrepTool(
  { workspace, signal, projectInstructions }: BuiltinToolExecutionContext,
  toolCall: GrepToolCall,
): Promise<ToolExecution> {
  const result = await executeGrep(workspace, toolCall.pattern, {
    ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
    signal,
  });
  const scopedOutput = projectInstructions?.formatInspectionOutput(
    result.inspectionTargetPaths,
    result.content,
  );
  return {
    content: scopedOutput?.content ?? result.content,
    ok: true,
    ...sourceTruncation(result),
    ...(scopedOutput !== undefined && scopedOutput.instructionPaths.length > 0
      ? { visibleProjectInstructionPaths: scopedOutput.instructionPaths }
      : {}),
  };
}

async function executeGitDiffTool(
  { workspace, signal }: BuiltinToolExecutionContext,
  toolCall: GitDiffToolCall,
): Promise<ToolExecution> {
  const result = await executeGitDiff(workspace, {
    ...(toolCall.mode !== undefined ? { mode: toolCall.mode } : {}),
    ...(toolCall.baseRef !== undefined ? { baseRef: toolCall.baseRef } : {}),
    ...(toolCall.headRef !== undefined ? { headRef: toolCall.headRef } : {}),
    ...(toolCall.mergeBase !== undefined
      ? { mergeBase: toolCall.mergeBase }
      : {}),
    ...(toolCall.paths !== undefined ? { paths: toolCall.paths } : {}),
    signal,
  });
  return {
    content: result.content,
    ok: true,
    ...sourceTruncation(result),
  };
}

async function executeGitStatusTool(
  { workspace, signal }: BuiltinToolExecutionContext,
  toolCall: GitStatusToolCall,
): Promise<ToolExecution> {
  const result = await executeGitStatus(workspace, {
    ...(toolCall.paths !== undefined ? { paths: toolCall.paths } : {}),
    signal,
  });
  return {
    content: result.content,
    ok: true,
    ...sourceTruncation(result),
  };
}

function executeEditTool(
  {
    workspace,
    readBeforeEdit,
    projectInstructions,
    recordCheckpoints,
  }: BuiltinToolExecutionContext,
  toolCall: EditToolCall,
): ToolExecution {
  if (projectInstructions !== undefined) {
    const target = resolveWorkspaceTarget(workspace, toolCall.path, "edit");
    projectInstructions.assertMutationAllowed([target.targetPath]);
  }
  const edits = toolCall.edits.map((edit) => ({
    oldText: edit.oldText,
    newText: edit.newText,
    ...(edit.replaceAll !== undefined ? { replaceAll: edit.replaceAll } : {}),
  }));
  const result = executeEdit(workspace, toolCall.path, edits, {
    ...(readBeforeEdit !== undefined ? { readBeforeEdit } : {}),
    recordCheckpoint: recordCheckpoints !== false,
  });
  return {
    content: result.content,
    ok: true,
    mutatedTargetPath: result.targetPath,
    checkpointOperations: [result.checkpointOperation],
  };
}

function executeWriteTool(
  {
    workspace,
    projectInstructions,
    recordCheckpoints,
  }: BuiltinToolExecutionContext,
  toolCall: WriteToolCall,
): ToolExecution {
  if (projectInstructions !== undefined) {
    const target = resolveWorkspaceCreateTarget(
      workspace,
      toolCall.path,
      "write",
    );
    projectInstructions.assertMutationAllowed([
      target.targetPath,
      target.resolvedTargetPath,
    ]);
  }
  const result = executeWrite(workspace, toolCall.path, toolCall.content, {
    ...(projectInstructions !== undefined ? { projectInstructions } : {}),
    recordCheckpoint: recordCheckpoints !== false,
  });
  return {
    content: result.content,
    ok: true,
    mutatedTargetPath: result.targetPath,
    checkpointOperations: [result.checkpointOperation],
  };
}

function executeApplyPatchTool(
  {
    workspace,
    readBeforeEdit,
    projectInstructions,
    recordCheckpoints,
  }: BuiltinToolExecutionContext,
  toolCall: ApplyPatchToolCall,
): ToolExecution {
  const result = executeApplyPatch(workspace, toolCall.patch, {
    ...(readBeforeEdit !== undefined ? { readBeforeEdit } : {}),
    ...(projectInstructions !== undefined ? { projectInstructions } : {}),
    recordCheckpoint: recordCheckpoints !== false,
  });
  return {
    content: result.content,
    ok: true,
    mutatedTargetPaths: result.targetPaths,
    checkpointOperations: result.checkpointOperations,
  };
}

async function executeBashTool(
  { workspace, signal, allowBash, bashPermission }: BuiltinToolExecutionContext,
  toolCall: BashToolCall,
): Promise<ToolExecution> {
  if (!allowBash) {
    return { content: disabledBashMessage(), ok: false };
  }

  if (bashPermission !== undefined) {
    const decision = await bashPermission.review({
      command: toolCall.command,
      cwd: workspace,
      signal,
    });
    if (decision.type === "deny") {
      return {
        content: deniedBashMessage(decision.message),
        ok: false,
      };
    }
  }

  const result = await executeBash(workspace, toolCall.command, {
    signal,
    ...(toolCall.timeoutMs !== undefined
      ? { timeoutMs: toolCall.timeoutMs }
      : {}),
  });
  return {
    content: result.content,
    ok: true,
    bashCommandEvidence: {
      command: toolCall.command,
      cwd: workspace,
      exitCode: result.exitCode,
    },
    ...sourceTruncation(result),
  };
}

function executeBuiltinToolCall(
  context: BuiltinToolExecutionContext,
  toolCall: ValidToolCall,
): ToolExecution | Promise<ToolExecution> {
  const parsed = builtinToolCallSchema.safeParse(toolCall);
  if (!parsed.success) {
    throw invalidBuiltinToolCallError(toolCall.tool, parsed.error);
  }

  switch (parsed.data.tool) {
    case "update_plan":
      return executeUpdatePlanTool(parsed.data);
    case "update_goal":
      return executeUpdateGoalTool(context, parsed.data);
    case "read":
      return executeReadTool(context, parsed.data);
    case "ls":
      return executeLsTool(context, parsed.data);
    case "glob":
      return executeGlobTool(context, parsed.data);
    case "grep":
      return executeGrepTool(context, parsed.data);
    case "git_status":
      return executeGitStatusTool(context, parsed.data);
    case "git_diff":
      return executeGitDiffTool(context, parsed.data);
    case "edit":
      return executeEditTool(context, parsed.data);
    case "write":
      return executeWriteTool(context, parsed.data);
    case "apply_patch":
      return executeApplyPatchTool(context, parsed.data);
    case "bash":
      return executeBashTool(context, parsed.data);
  }
}

export async function executeToolCall(
  options: ExecuteToolCallOptions,
): Promise<ToolExecution> {
  const { toolCall, ...context } = options;
  if (isInvalidToolCall(toolCall)) {
    return {
      content: invalidToolCallFailureMessage(toolCall),
      ok: false,
    };
  }
  try {
    return await executeBuiltinToolCall(context, toolCall);
  } catch (error) {
    if (isAbortThrow(error, context.signal)) {
      throw error;
    }
    if (error instanceof ScopedProjectInstructionsNotVisibleError) {
      return {
        content: scopedProjectInstructionsFailureMessage(error),
        ok: false,
        visibleProjectInstructionPaths: error.instructionPaths,
      };
    }
    if (!isRecoverableToolError(error)) {
      return {
        content: unhandledToolFailureMessage(toolCall.tool, error),
        ok: false,
      };
    }
    return { content: toolFailureMessage(error), ok: false };
  }
}
