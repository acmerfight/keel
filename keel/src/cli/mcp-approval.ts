import type {
  McpPermissionPolicy,
  McpPermissionRequest,
} from "../mcp/runtime-types.ts";
import { escapeApprovalText } from "./bash-approval-text.ts";
import type { LineReader } from "./interactive-session/line-reader.ts";

export function denyMcpPermissionPolicy(message: string): McpPermissionPolicy {
  return {
    review: () => ({ type: "deny", message }),
  };
}

export function createPromptedMcpPermissionPolicy(
  lineReader: LineReader,
  writeStderr: (text: string) => void,
  options: {
    readonly onPromptStart?: () => void;
    readonly onPromptEnd?: () => void;
  } = {},
): McpPermissionPolicy {
  return {
    review: async (request: McpPermissionRequest) => {
      options.onPromptStart?.();
      try {
        const sequence = lineReader.sequence();
        writeStderr(
          [
            "Approve MCP tool call?",
            `origin: ${escapeApprovalText(request.origin)}`,
            `tool: ${escapeApprovalText(`${request.serverId}/${request.rawToolName}`)}`,
            `arguments: ${escapeApprovalText(JSON.stringify(request.arguments))}`,
            "MCP metadata and results are external and untrusted. The call may have unknown side effects.",
            "[y] allow once, [n] deny; any other input denies: ",
          ].join("\n"),
        );
        const rawAnswer = await lineReader.readLineAfter(
          sequence,
          request.signal,
        );
        if (rawAnswer === null) {
          return {
            type: "deny",
            message: "MCP approval was interrupted or input closed.",
          };
        }
        const answer = rawAnswer.trim().toLowerCase();
        return answer === "y" || answer === "yes"
          ? { type: "allow" }
          : {
              type: "deny",
              message: "User did not approve this MCP tool call.",
            };
      } finally {
        options.onPromptEnd?.();
      }
    },
  };
}
