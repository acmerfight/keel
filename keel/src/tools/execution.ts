import {
  isRecoverableToolErrorCode,
  KeelError,
  type RecoverableToolErrorCode,
} from "../core/error.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeBash } from "./bash.ts";
import { executeEdit } from "./edit.ts";
import { executeGlob } from "./glob.ts";
import { executeGrep } from "./grep.ts";
import { executeRead } from "./read.ts";
import type { ToolCall } from "./registry.ts";
import { executeWrite } from "./write.ts";

export interface ExecuteToolCallOptions {
  readonly workspace: string;
  readonly toolCall: ToolCall;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly bashPermission?: BashPermissionPolicy;
}

interface RecoverableToolError extends KeelError {
  readonly code: RecoverableToolErrorCode;
  readonly recovery: string;
}

export interface ToolExecution {
  readonly content: string;
  readonly ok: boolean;
}

function isRecoverableToolError(error: unknown): error is RecoverableToolError {
  return error instanceof KeelError && isRecoverableToolErrorCode(error.code);
}

function toolFailureMessage(error: RecoverableToolError): string {
  return `Tool failed: ${error.message}\nRecovery: ${error.recovery}`;
}

function deniedBashMessage(message: string): string {
  return `Tool failed: bash permission denied: ${message}\nRecovery: Ask the user for permission or choose a non-shell approach.`;
}

export async function executeToolCall(
  options: ExecuteToolCallOptions,
): Promise<ToolExecution> {
  const { workspace, toolCall, signal, allowBash, bashPermission } = options;
  switch (toolCall.tool) {
    case "glob": {
      try {
        const result = await executeGlob(workspace, toolCall.pattern, {
          ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
          signal,
        });
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "grep": {
      try {
        const result = await executeGrep(workspace, toolCall.pattern, {
          ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
          signal,
        });
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "read": {
      try {
        const result = executeRead(workspace, toolCall.path, {
          offset: toolCall.offset,
          limit: toolCall.limit,
        });
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "bash": {
      if (!allowBash) {
        return {
          content:
            "Tool failed: bash failed: shell commands are disabled. Re-run with --bash-policy ask, --bash-policy trusted, or --allow-bash to enable them.",
          ok: false,
        };
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

      try {
        const result = await executeBash(workspace, toolCall.command, {
          signal,
          ...(toolCall.timeoutMs !== undefined
            ? { timeoutMs: toolCall.timeoutMs }
            : {}),
        });
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "edit": {
      try {
        const result = executeEdit(
          workspace,
          toolCall.path,
          toolCall.oldString,
          toolCall.newString,
          toolCall.replaceAll !== undefined
            ? { replaceAll: toolCall.replaceAll }
            : {},
        );
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "write": {
      try {
        const result = executeWrite(workspace, toolCall.path, toolCall.content);
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
  }
}
