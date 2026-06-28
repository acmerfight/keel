import {
  isRecoverableToolErrorCode,
  KeelError,
  type RecoverableToolErrorCode,
} from "../core/error.ts";
import type { RecordLastBatchCheckpointOperation } from "../core/git.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeApplyPatch } from "./apply-patch.ts";
import { executeBash } from "./bash.ts";
import { executeEdit } from "./edit.ts";
import { executeGitDiff } from "./git-diff.ts";
import { executeGlob } from "./glob.ts";
import { executeGrep } from "./grep.ts";
import { executeLs } from "./ls.ts";
import { executeRead } from "./read.ts";
import type { ProjectInstructionVisibilityState } from "./scoped-project-instructions.ts";
import { ScopedProjectInstructionsNotVisibleError } from "./scoped-project-instructions.ts";
import { builtinToolCallSchema, type ToolCall } from "./tool-call.ts";
import { invalidBuiltinToolCallError } from "./tool-error.ts";
import {
  resolveWorkspaceCreateTarget,
  resolveWorkspaceTarget,
} from "./workspace-path.ts";
import { executeWrite } from "./write.ts";

type ReadToolCall = Extract<ToolCall, { readonly tool: "read" }>;
type LsToolCall = Extract<ToolCall, { readonly tool: "ls" }>;
type GlobToolCall = Extract<ToolCall, { readonly tool: "glob" }>;
type GrepToolCall = Extract<ToolCall, { readonly tool: "grep" }>;
type GitDiffToolCall = Extract<ToolCall, { readonly tool: "git_diff" }>;
type EditToolCall = Extract<ToolCall, { readonly tool: "edit" }>;
type WriteToolCall = Extract<ToolCall, { readonly tool: "write" }>;
type ApplyPatchToolCall = Extract<ToolCall, { readonly tool: "apply_patch" }>;
type BashToolCall = Extract<ToolCall, { readonly tool: "bash" }>;

interface BuiltinToolExecutionContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly bashPermission?: BashPermissionPolicy;
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
  readonly projectInstructions?: ProjectInstructionVisibilityState;
}

export interface ToolExecution {
  readonly content: string;
  readonly ok: boolean;
  readonly readTargetPath?: string;
  readonly readTargetOffset?: number;
  readonly readTargetLimit?: number;
  readonly mutatedTargetPath?: string;
  readonly mutatedTargetPaths?: readonly string[];
  readonly visibleProjectInstructionPaths?: readonly string[];
  readonly checkpointOperations?: readonly RecordLastBatchCheckpointOperation[];
}

export interface ExecuteToolCallOptions extends BuiltinToolExecutionContext {
  readonly toolCall: ToolCall;
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

function scopedProjectInstructionsFailureMessage(
  error: ScopedProjectInstructionsNotVisibleError,
): string {
  return `Tool failed: ${error.message}\nRecovery: ${error.recovery}`;
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
  return { content: result.content, ok: true };
}

async function executeGlobTool(
  { workspace, signal }: BuiltinToolExecutionContext,
  toolCall: GlobToolCall,
): Promise<ToolExecution> {
  const result = await executeGlob(workspace, toolCall.pattern, {
    ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
    signal,
  });
  return { content: result.content, ok: true };
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
    ...(toolCall.paths !== undefined ? { paths: toolCall.paths } : {}),
    signal,
  });
  return { content: result.content, ok: true };
}

function executeEditTool(
  {
    workspace,
    readBeforeEdit,
    projectInstructions,
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
  });
  return {
    content: result.content,
    ok: true,
    mutatedTargetPath: result.targetPath,
    checkpointOperations: [result.checkpointOperation],
  };
}

function executeWriteTool(
  { workspace, projectInstructions }: BuiltinToolExecutionContext,
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
  }: BuiltinToolExecutionContext,
  toolCall: ApplyPatchToolCall,
): ToolExecution {
  const result = executeApplyPatch(workspace, toolCall.patch, {
    ...(readBeforeEdit !== undefined ? { readBeforeEdit } : {}),
    ...(projectInstructions !== undefined ? { projectInstructions } : {}),
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
  return { content: result.content, ok: true };
}

function executeBuiltinToolCall(
  context: BuiltinToolExecutionContext,
  toolCall: ToolCall,
): ToolExecution | Promise<ToolExecution> {
  const parsed = builtinToolCallSchema.safeParse(toolCall);
  if (!parsed.success) {
    throw invalidBuiltinToolCallError(toolCall.tool, parsed.error);
  }

  switch (parsed.data.tool) {
    case "read":
      return executeReadTool(context, parsed.data);
    case "ls":
      return executeLsTool(context, parsed.data);
    case "glob":
      return executeGlobTool(context, parsed.data);
    case "grep":
      return executeGrepTool(context, parsed.data);
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
  try {
    return await executeBuiltinToolCall(context, toolCall);
  } catch (error) {
    if (error instanceof ScopedProjectInstructionsNotVisibleError) {
      return {
        content: scopedProjectInstructionsFailureMessage(error),
        ok: false,
        visibleProjectInstructionPaths: error.instructionPaths,
      };
    }
    if (!isRecoverableToolError(error)) {
      throw error;
    }
    return { content: toolFailureMessage(error), ok: false };
  }
}
