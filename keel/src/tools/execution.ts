import { z } from "zod";
import {
  errorMessage,
  isAbortThrow,
  isRecoverableToolErrorCode,
  KeelError,
  type RecoverableToolErrorCode,
} from "../core/error.ts";
import type { RecordLastBatchCheckpointOperation } from "../core/git.ts";
import type { ReadResourceObservation } from "../core/resource-observation.ts";
import {
  copySessionGoal,
  formatSessionGoalBlockedProposalToolResult,
  formatSessionGoalBlockedToolResult,
  formatSessionGoalCompletedToolResult,
  normalizeSessionGoalCompletionCommand,
  normalizeSessionGoalStatusReason,
  type SessionGoal,
  type SessionGoalBlockedAuditCount,
  sessionGoalAccounting,
  sessionGoalCompletionContract,
  withSessionGoalRuntimeOutcome,
} from "../core/session-goal.ts";
import {
  formatSessionTaskProgressToolResult,
  type SessionTaskProgress,
  sessionTaskProgressFromPlan,
} from "../core/task-progress.ts";
import type { RecordUndoCheckpointResult } from "../core/undo-protection.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import type {
  SkillActivationCapability,
  SkillActivationRecord,
} from "../skills/model.ts";
import { WorkflowSkillError } from "../skills/model.ts";
import { executeApplyPatch } from "./apply-patch.ts";
import { executeBash } from "./bash.ts";
import { executeEdit } from "./edit.ts";
import { executeGitDiff } from "./git-diff.ts";
import { executeGitStatus } from "./git-status.ts";
import { executeGlob } from "./glob.ts";
import { executeGrep } from "./grep.ts";
import { executeLs } from "./ls.ts";
import { executeRead } from "./read.ts";
import { observeReadResource } from "./read-resource-observation.ts";
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
type SkillToolCall = Extract<ValidToolCall, { readonly tool: "skill" }>;
type SkillSearchToolCall = Extract<
  ValidToolCall,
  { readonly tool: "skill_search" }
>;
type SkillResourceToolCall = Extract<
  ValidToolCall,
  { readonly tool: "skill_resource" }
>;
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
  readonly skillActivation?: Pick<
    SkillActivationCapability,
    "activate" | "search" | "readResource"
  >;
  readonly recordCheckpoints?: boolean;
  readonly bashPermission?: BashPermissionPolicy;
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
  readonly projectInstructions?: ProjectInstructionVisibilityState;
  readonly sessionGoal?: SessionGoal;
  readonly completionProposalHasFollowingToolCalls?: boolean;
  readonly evaluateAssertionGoalCompletion?: (
    goal: AssertionGoalCompletionContract,
  ) => Promise<AssertionGoalCompletionEvaluation>;
}

interface BashCommandEvidence {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
}

interface AssertionGoalCompletionContract {
  readonly objective: string;
  readonly completionCriterion: string;
}

interface AssertionGoalCompletionEvaluation {
  readonly completed: boolean;
  readonly reason: string;
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
  readonly resourceObservation?: ReadResourceObservation;
  readonly mutatedTargetPath?: string;
  readonly mutatedTargetPaths?: readonly string[];
  readonly visibleProjectInstructionPaths?: readonly string[];
  readonly checkpointOperations?: readonly RecordLastBatchCheckpointOperation[];
  readonly undoCheckpoint?: RecordUndoCheckpointResult;
  readonly taskProgressUpdate?: SessionTaskProgress;
  readonly sessionGoalUpdate?: SessionGoal;
  readonly bashCommandEvidence?: BashCommandEvidence;
  readonly skillActivation?: SkillActivationRecord;
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

function executeSkillTool(
  context: BuiltinToolExecutionContext,
  toolCall: SkillToolCall,
): ToolExecution {
  if (context.skillActivation === undefined) {
    return {
      content:
        "Tool failed: skill activation is unavailable because no valid workflow skill catalog was exposed.\nRecovery: Continue without a skill.",
      ok: false,
    };
  }
  try {
    const activation = context.skillActivation.activate(toolCall.name);
    return {
      content: activation.newlyActivated
        ? `Workflow skill ${activation.activation.qualifiedName} activated. Its instructions and resource index are now active in the system context.`
        : `Workflow skill ${activation.activation.qualifiedName} is already active; no instructions were duplicated.`,
      ok: true,
      ...(activation.record === undefined
        ? {}
        : { skillActivation: activation.record }),
    };
  } catch (error) {
    if (!(error instanceof WorkflowSkillError)) {
      throw error;
    }
    return {
      content: `Tool failed: ${error.message.replace(/^Error: /u, "")}\nRecovery: Use an exact qualified name from the current scoped catalog, search omitted entries first, or continue without a skill.`,
      ok: false,
    };
  }
}

function executeSkillSearchTool(
  context: BuiltinToolExecutionContext,
  toolCall: SkillSearchToolCall,
): ToolExecution {
  if (context.skillActivation === undefined) {
    return {
      content:
        "Tool failed: skill catalog search is unavailable.\nRecovery: Continue without a skill.",
      ok: false,
    };
  }
  const matches = context.skillActivation.search(toolCall.query);
  return {
    content:
      matches.length === 0
        ? "No matching implicit workflow skills found."
        : matches
            .map(
              (skill) =>
                `${skill.qualifiedName}: ${skill.description} (${skill.relativePath})`,
            )
            .join("\n"),
    ok: true,
  };
}

function executeSkillResourceTool(
  context: BuiltinToolExecutionContext,
  toolCall: SkillResourceToolCall,
): ToolExecution {
  if (context.skillActivation === undefined) {
    return {
      content:
        "Tool failed: skill resource access is unavailable.\nRecovery: Continue without the resource.",
      ok: false,
    };
  }
  try {
    return {
      content: context.skillActivation.readResource(
        toolCall.skill,
        toolCall.path,
      ),
      ok: true,
    };
  } catch (error) {
    if (!(error instanceof WorkflowSkillError)) throw error;
    return {
      content: `Tool failed: ${error.message.replace(/^Error: /u, "")}\nRecovery: Use an exact active qualified skill name and one advertised resource path.`,
      ok: false,
    };
  }
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

function rejectedGoalCompletion(
  sessionGoal: Extract<SessionGoal, { readonly status: "active" }>,
  content: string,
  reason: string,
): ToolExecution {
  return {
    content,
    ok: false,
    sessionGoalUpdate: withSessionGoalRuntimeOutcome(sessionGoal, {
      kind: "completion_rejected",
      reason,
    }),
  };
}

function commandVerificationFailureContent(
  command: string,
  exitCode: number | null,
  verificationOutput: string,
): string {
  return `Tool failed: update_goal failed: completion command ${JSON.stringify(command)} exited with code ${exitCode ?? "unknown"} at the completion boundary.\nVerification output:\n${verificationOutput}\nRecovery: Fix the failing verification, then propose completion again.`;
}

async function executeUpdateGoalTool(
  {
    workspace,
    allowBash,
    signal,
    bashPermission,
    sessionGoal,
    completionProposalHasFollowingToolCalls,
    evaluateAssertionGoalCompletion,
  }: BuiltinToolExecutionContext,
  toolCall: UpdateGoalToolCall,
): Promise<ToolExecution> {
  if (sessionGoal?.status !== "active") {
    return {
      content:
        "Tool failed: update_goal failed: no active session goal is set.\nRecovery: Continue without updating the goal, or ask the user to set a saved session goal first.",
      ok: false,
    };
  }
  if (toolCall.status === "blocked") {
    const blockedReason = normalizeSessionGoalStatusReason(
      z.string().parse(toolCall.reason),
    );
    const priorAudit = sessionGoal.blockedAudit;
    if (priorAudit?.consecutiveCount === 2) {
      const blockedGoalWithoutOutcome: SessionGoal = {
        objective: sessionGoal.objective,
        status: "blocked",
        statusReason: blockedReason,
        ...sessionGoalAccounting(sessionGoal),
        ...sessionGoalCompletionContract(sessionGoal),
      };
      const blockedGoal = withSessionGoalRuntimeOutcome(
        blockedGoalWithoutOutcome,
        { kind: "blocked", reason: blockedReason },
      );
      return {
        content: formatSessionGoalBlockedToolResult(blockedGoal),
        ok: true,
        sessionGoalUpdate: copySessionGoal(blockedGoal),
      };
    }
    const consecutiveCount: SessionGoalBlockedAuditCount =
      priorAudit?.consecutiveCount === 1 ? 2 : 1;
    const blockedProposalGoalWithoutOutcome = {
      objective: sessionGoal.objective,
      status: "active",
      ...sessionGoalAccounting(sessionGoal),
      blockedAudit: {
        consecutiveCount,
        reason: blockedReason,
      },
      ...sessionGoalCompletionContract(sessionGoal),
    } satisfies Extract<SessionGoal, { readonly status: "active" }> & {
      readonly blockedAudit: NonNullable<
        Extract<SessionGoal, { readonly status: "active" }>["blockedAudit"]
      >;
    };
    const blockedProposalGoal = withSessionGoalRuntimeOutcome(
      blockedProposalGoalWithoutOutcome,
      {
        kind: "blocker_audit",
        reason: `Blocked audit ${consecutiveCount}/3 recorded: ${blockedReason}`,
      },
    );
    return {
      content: formatSessionGoalBlockedProposalToolResult(blockedProposalGoal),
      ok: true,
      sessionGoalUpdate: copySessionGoal(blockedProposalGoal),
    };
  }
  if (
    sessionGoal.criterionKind === undefined ||
    sessionGoal.completionCriterion === undefined
  ) {
    return rejectedGoalCompletion(
      sessionGoal,
      "Tool failed: update_goal failed: no completion criterion is set for the active session goal.\nRecovery: Ask the user to add one with /goal verify <command> or /goal done-when <criterion>, continue working, or ask the user to use /goal complete for an explicit override.",
      "Completion was rejected because the active goal has no completion criterion.",
    );
  }
  if (completionProposalHasFollowingToolCalls === true) {
    return rejectedGoalCompletion(
      sessionGoal,
      "Tool failed: update_goal failed: completed must be the final tool call in an agent turn.\nRecovery: Finish the remaining actions, inspect their results, then propose completion in a later turn.",
      "Completion was rejected because update_goal(completed) was not the final tool call in its agent turn.",
    );
  }
  if (sessionGoal.criterionKind === "assertion") {
    if (evaluateAssertionGoalCompletion === undefined) {
      return rejectedGoalCompletion(
        sessionGoal,
        "Tool failed: update_goal failed: assertion completion evaluator is unavailable.\nRecovery: Continue gathering evidence, ask the user to use /goal complete for an explicit override, or retry in an agent session that supports assertion evaluation.",
        "Completion was rejected because the assertion evaluator was unavailable.",
      );
    }
    const evaluation = await evaluateAssertionGoalCompletion({
      objective: sessionGoal.objective,
      completionCriterion: sessionGoal.completionCriterion,
    });
    if (!evaluation.completed) {
      return rejectedGoalCompletion(
        sessionGoal,
        "Tool failed: update_goal failed: assertion completion evaluator rejected completion.\n" +
          `Reason: ${evaluation.reason}\n` +
          "Recovery: Continue gathering or surfacing evidence that satisfies the assertion criterion, then call update_goal again only after the evidence is visible.",
        evaluation.reason,
      );
    }
    const completedGoalWithoutOutcome: SessionGoal = {
      objective: sessionGoal.objective,
      status: "completed",
      ...sessionGoalAccounting(sessionGoal),
      ...sessionGoalCompletionContract(sessionGoal),
      completionEvidence: {
        kind: "assertion_evaluator",
        reason: evaluation.reason,
      },
    };
    const completedGoal = withSessionGoalRuntimeOutcome(
      completedGoalWithoutOutcome,
      {
        kind: "completed",
        reason: `Assertion evaluator approved completion: ${evaluation.reason}`,
      },
    );
    return {
      content: formatSessionGoalCompletedToolResult(completedGoal),
      ok: true,
      sessionGoalUpdate: copySessionGoal(completedGoal),
    };
  }
  const expectedCommand = normalizeSessionGoalCompletionCommand(
    sessionGoal.completionCriterion,
  );
  if (!allowBash) {
    return rejectedGoalCompletion(
      sessionGoal,
      `Tool failed: update_goal failed: Runtime cannot run command completion criterion ${JSON.stringify(expectedCommand)} because Bash is disabled.\nRecovery: Ask the user to resume with --bash-policy ask or --bash-policy trusted, or to use /goal complete after checking it manually.`,
      `Completion was rejected because Runtime could not run command criterion ${JSON.stringify(expectedCommand)} while Bash was disabled.`,
    );
  }
  if (bashPermission !== undefined) {
    const decision = await bashPermission.review({
      command: expectedCommand,
      cwd: workspace,
      signal,
    });
    if (decision.type === "deny") {
      return rejectedGoalCompletion(
        sessionGoal,
        `Tool failed: update_goal failed: command completion verification was denied: ${decision.message}\nRecovery: Ask the user for permission or use /goal complete after checking it manually.`,
        `Completion was rejected because permission to run command criterion ${JSON.stringify(expectedCommand)} was denied.`,
      );
    }
  }
  const verification = await executeBash(workspace, expectedCommand, {
    signal,
    ...(sessionGoal.verificationTimeoutMs !== undefined
      ? { timeoutMs: sessionGoal.verificationTimeoutMs }
      : {}),
  });
  if (verification.exitCode !== 0) {
    const rejection = rejectedGoalCompletion(
      sessionGoal,
      commandVerificationFailureContent(
        expectedCommand,
        verification.exitCode,
        verification.content,
      ),
      `Completion was rejected because command criterion ${JSON.stringify(expectedCommand)} exited with code ${verification.exitCode ?? "unknown"} at the completion boundary.`,
    );
    const truncation = sourceTruncation(verification);
    return {
      ...rejection,
      ...truncation,
      ...(truncation.artifactContent !== undefined
        ? {
            artifactContent: commandVerificationFailureContent(
              expectedCommand,
              verification.exitCode,
              truncation.artifactContent,
            ),
          }
        : {}),
    };
  }
  const completedGoalWithoutOutcome: SessionGoal = {
    objective: sessionGoal.objective,
    status: "completed",
    ...sessionGoalAccounting(sessionGoal),
    ...sessionGoalCompletionContract(sessionGoal),
    completionEvidence: {
      kind: "command",
      command: expectedCommand,
      cwd: workspace,
      exitCode: 0,
      freshness: "at_completion",
    },
  };
  const completedGoal = withSessionGoalRuntimeOutcome(
    completedGoalWithoutOutcome,
    {
      kind: "completed",
      reason: `Completion command ${JSON.stringify(expectedCommand)} exited 0 at the completion boundary.`,
    },
  );
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
    resourceObservation: observeReadResource({
      workspace,
      targetPath: result.targetPath,
      content: result.content,
    }),
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
    ...(result.undoCheckpoint !== undefined
      ? { undoCheckpoint: result.undoCheckpoint }
      : {}),
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
    ...(result.undoCheckpoint !== undefined
      ? { undoCheckpoint: result.undoCheckpoint }
      : {}),
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
    ...(result.undoCheckpoint !== undefined
      ? { undoCheckpoint: result.undoCheckpoint }
      : {}),
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
    case "skill_resource":
      return executeSkillResourceTool(context, parsed.data);
    case "skill_search":
      return executeSkillSearchTool(context, parsed.data);
    case "skill":
      return executeSkillTool(context, parsed.data);
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
