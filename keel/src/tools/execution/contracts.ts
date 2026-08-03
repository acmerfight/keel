import type { RecordLastBatchCheckpointOperation } from "../../core/git.ts";
import type { ReadResourceObservation } from "../../core/resource-observation.ts";
import type { SessionGoal } from "../../core/session-goal.ts";
import type { SessionTaskProgress } from "../../core/task-progress.ts";
import type { McpPreservedToolResult } from "../../mcp/runtime-types.ts";
import type { SkillActivationRecord } from "../../skills/model.ts";
import type { FileRevision } from "../file-revision.ts";
import type { AgentMemoryOperation } from "../memory.ts";
import type { ToolOutputArtifact, ToolResult } from "../types.ts";

export interface ReadToolExecutionEffect {
  readonly kind: "read";
  readonly targetPath: string;
  readonly fileRevision: FileRevision;
  readonly offset?: number;
  readonly limit?: number;
  readonly resourceObservation: ReadResourceObservation;
}

interface MutationToolExecutionEffect {
  readonly kind: "mutation";
  readonly targetPaths: readonly string[];
  readonly checkpointOperations: readonly RecordLastBatchCheckpointOperation[];
}

export interface VisibleProjectInstructionsToolExecutionEffect {
  readonly kind: "visible_project_instructions";
  readonly instructionPaths: readonly string[];
}

interface TaskProgressToolExecutionEffect {
  readonly kind: "task_progress";
  readonly taskProgress: SessionTaskProgress;
}

interface SessionGoalToolExecutionEffect {
  readonly kind: "session_goal";
  readonly goal: SessionGoal;
}

interface BashCommandEvidence {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
}

interface BashCommandToolExecutionEffect {
  readonly kind: "bash_command";
  readonly evidence: BashCommandEvidence;
}

interface OpaqueWorkspaceMutationToolExecutionEffect {
  readonly kind: "opaque_workspace_mutation";
}

interface SkillActivationToolExecutionEffect {
  readonly kind: "skill_activation";
  readonly activation: SkillActivationRecord;
}

interface MemoryOperationToolExecutionEffect {
  readonly kind: "memory_operation";
  readonly operation: AgentMemoryOperation;
}

interface ExternalToolResultExecutionEffect {
  readonly kind: "external_tool_result";
  readonly result: McpPreservedToolResult;
}

type ToolExecutionEffect =
  | ReadToolExecutionEffect
  | MutationToolExecutionEffect
  | VisibleProjectInstructionsToolExecutionEffect
  | TaskProgressToolExecutionEffect
  | SessionGoalToolExecutionEffect
  | BashCommandToolExecutionEffect
  | OpaqueWorkspaceMutationToolExecutionEffect
  | SkillActivationToolExecutionEffect
  | MemoryOperationToolExecutionEffect
  | ExternalToolResultExecutionEffect;

type FailedToolExecutionEffect =
  | VisibleProjectInstructionsToolExecutionEffect
  | SessionGoalToolExecutionEffect
  | ExternalToolResultExecutionEffect;

interface ToolExecutionBase {
  readonly content: string;
  readonly sourceTruncated?: boolean;
  readonly artifact?: ToolOutputArtifact;
}

interface SuccessfulToolExecution extends ToolExecutionBase {
  readonly ok: true;
  readonly effects: readonly ToolExecutionEffect[];
}

export interface FailedToolExecution extends ToolExecutionBase {
  readonly ok: false;
  readonly effects: readonly FailedToolExecutionEffect[];
}

interface SuccessfulReadToolExecution extends ToolExecutionBase {
  readonly ok: true;
  readonly effects: readonly [
    ReadToolExecutionEffect,
    ...VisibleProjectInstructionsToolExecutionEffect[],
  ];
}

export type ReadToolExecution =
  | SuccessfulReadToolExecution
  | FailedToolExecution;

export const NO_TOOL_EXECUTION_EFFECTS = [] as const;

export function toolExecutionEffect<K extends ToolExecutionEffect["kind"]>(
  execution: SuccessfulToolExecution,
  kind: K,
): Extract<ToolExecutionEffect, { readonly kind: K }> | undefined;
export function toolExecutionEffect<
  K extends FailedToolExecutionEffect["kind"],
>(
  execution: FailedToolExecution,
  kind: K,
): Extract<FailedToolExecutionEffect, { readonly kind: K }> | undefined;
export function toolExecutionEffect<
  K extends FailedToolExecutionEffect["kind"],
>(
  execution: ToolExecution,
  kind: K,
): Extract<FailedToolExecutionEffect, { readonly kind: K }> | undefined;
export function toolExecutionEffect(
  execution: ToolExecution,
  kind: ToolExecutionEffect["kind"],
): ToolExecutionEffect | undefined {
  return execution.effects.find((effect) => effect.kind === kind);
}

export function toolExecutionEffects<K extends ToolExecutionEffect["kind"]>(
  execution: SuccessfulToolExecution,
  kind: K,
): readonly Extract<ToolExecutionEffect, { readonly kind: K }>[];
export function toolExecutionEffects<
  K extends FailedToolExecutionEffect["kind"],
>(
  execution: FailedToolExecution,
  kind: K,
): readonly Extract<FailedToolExecutionEffect, { readonly kind: K }>[];
export function toolExecutionEffects<
  K extends FailedToolExecutionEffect["kind"],
>(
  execution: ToolExecution,
  kind: K,
): readonly Extract<FailedToolExecutionEffect, { readonly kind: K }>[];
export function toolExecutionEffects(
  execution: ToolExecution,
  kind: ToolExecutionEffect["kind"],
): readonly ToolExecutionEffect[] {
  return execution.effects.filter((effect) => effect.kind === kind);
}

export type ToolExecution = SuccessfulToolExecution | FailedToolExecution;

export function sourceTruncation(result: ToolResult): {
  readonly sourceTruncated?: true;
  readonly artifact?: ToolOutputArtifact;
} {
  return {
    ...(result.sourceTruncated === true ? { sourceTruncated: true } : {}),
    ...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
  };
}
