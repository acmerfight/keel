import type {
  McpPermissionPolicy,
  McpPermissionRequest,
} from "../mcp/runtime-types.ts";
import { escapeApprovalText } from "./bash-approval-text.ts";
import type { LineReader } from "./interactive-session/line-reader.ts";

interface McpPromptLifecycle {
  readonly onPromptStart: () => void;
  readonly onPromptEnd: () => void;
}

function authorizationDisplay(request: McpPermissionRequest): string {
  const identity = request.authorizationIdentity;
  return identity.kind === "anonymous"
    ? "authorization: anonymous"
    : `authorization: OAuth issuer=${escapeApprovalText(identity.issuer)} client=${escapeApprovalText(identity.clientId)} grant=${escapeApprovalText(identity.grantId)}`;
}

export const trustedMcpPermissionPolicy: McpPermissionPolicy = {
  review: () => ({ type: "allow" }),
};

export function createPromptedMcpPermissionPolicy(
  lineReader: LineReader,
  writeStderr: (text: string) => void,
  lifecycle: McpPromptLifecycle = {
    onPromptStart: () => {},
    onPromptEnd: () => {},
  },
): McpPermissionPolicy {
  return {
    review: async (request: McpPermissionRequest) => {
      lifecycle.onPromptStart();
      try {
        const sequence = lineReader.sequence();
        writeStderr(
          [
            "Approve MCP tool call?",
            `origin: ${escapeApprovalText(request.origin)}`,
            `tool: ${escapeApprovalText(`${request.serverId}/${request.rawToolName}`)}`,
            `arguments: ${escapeApprovalText(JSON.stringify(request.arguments))}`,
            authorizationDisplay(request),
            `configuration: sha256:${request.configurationDigest}`,
            `descriptor: sha256:${request.descriptorDigest}`,
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
        lifecycle.onPromptEnd();
      }
    },
  };
}
