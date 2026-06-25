import {
  isRecoverableToolErrorCode,
  KeelError,
  type RecoverableToolErrorCode,
} from "../core/error.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import type { ToolExecution } from "./builtin.ts";
import { executeBuiltinToolCall, type ToolCall } from "./registry.ts";
import type { ProjectInstructionVisibilityState } from "./scoped-project-instructions.ts";
import { ScopedProjectInstructionsNotVisibleError } from "./scoped-project-instructions.ts";

export interface ExecuteToolCallOptions {
  readonly workspace: string;
  readonly toolCall: ToolCall;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly bashPermission?: BashPermissionPolicy;
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
  readonly projectInstructions?: ProjectInstructionVisibilityState;
}

export type { ToolExecution } from "./builtin.ts";

interface RecoverableToolError extends KeelError {
  readonly code: RecoverableToolErrorCode;
  readonly recovery: string;
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
