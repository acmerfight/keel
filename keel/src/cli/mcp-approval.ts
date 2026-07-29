import type {
  McpPermissionPolicy,
  McpPermissionRequest,
} from "../mcp/runtime-types.ts";
import { escapeApprovalText } from "./bash-approval-text.ts";
import type { LineReader } from "./interactive-session/line-reader.ts";
import {
  hasMcpProjectApprovalGrant,
  McpProjectApprovalsError,
  mcpProjectApprovalGrant,
  saveMcpProjectApprovalGrant,
} from "./mcp-project-approvals.ts";

interface McpApprovalRuntime {
  readonly env: (key: string) => string | undefined;
}

type McpApprovalPrompt =
  | { readonly kind: "headless"; readonly deniedMessage: string }
  | {
      readonly kind: "interactive";
      readonly lineReader: LineReader;
      readonly writeStderr: (text: string) => void;
      readonly onPromptStart: () => void;
      readonly onPromptEnd: () => void;
    };

function authorizationDisplay(request: McpPermissionRequest): string {
  const identity = request.authorizationIdentity;
  return identity.kind === "anonymous"
    ? "authorization: anonymous"
    : `authorization: OAuth issuer=${escapeApprovalText(identity.issuer)} client=${escapeApprovalText(identity.clientId)} grant=${escapeApprovalText(identity.grantId)}`;
}

export function createMcpPermissionPolicy(options: {
  readonly runtime: McpApprovalRuntime;
  readonly projectRoot: string;
  readonly prompt: McpApprovalPrompt;
}): McpPermissionPolicy {
  return {
    review: async (request: McpPermissionRequest) => {
      const grant = mcpProjectApprovalGrant(options.projectRoot, request);
      let approvalLookupError: McpProjectApprovalsError | null = null;
      let hasGrant = false;
      try {
        hasGrant = await hasMcpProjectApprovalGrant(options.runtime, grant);
      } catch (error) {
        if (!(error instanceof McpProjectApprovalsError)) throw error;
        approvalLookupError = error;
      }
      if (hasGrant) {
        return { type: "allow" };
      }
      if (options.prompt.kind === "headless") {
        return {
          type: "deny",
          message:
            approvalLookupError === null
              ? options.prompt.deniedMessage
              : approvalLookupError.message,
        };
      }
      options.prompt.onPromptStart();
      try {
        const sequence = options.prompt.lineReader.sequence();
        if (approvalLookupError !== null) {
          options.prompt.writeStderr(
            `${approvalLookupError.message}\nContinuing with one-time interactive approval; saved MCP approvals are unavailable.\n`,
          );
        }
        options.prompt.writeStderr(
          [
            "Approve MCP tool call?",
            `origin: ${escapeApprovalText(request.origin)}`,
            `tool: ${escapeApprovalText(`${request.serverId}/${request.rawToolName}`)}`,
            `arguments: ${escapeApprovalText(JSON.stringify(request.arguments))}`,
            authorizationDisplay(request),
            `configuration: sha256:${request.configurationDigest}`,
            `descriptor: sha256:${request.descriptorDigest}`,
            "Saved approval policy: this project and these exact arguments only.",
            "MCP metadata and results are external and untrusted. The call may have unknown side effects.",
            "[y] allow once, [s] save exact project approval, [n] deny; any other input denies: ",
          ].join("\n"),
        );
        const rawAnswer = await options.prompt.lineReader.readLineAfter(
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
        if (answer === "y" || answer === "yes") {
          return { type: "allow" };
        }
        if (answer === "s" || answer === "save") {
          try {
            await saveMcpProjectApprovalGrant(options.runtime, grant);
          } catch (error) {
            if (!(error instanceof McpProjectApprovalsError)) throw error;
            return {
              type: "deny",
              message: `${error.message} Use y to allow once after repairing or clearing MCP project approvals.`,
            };
          }
          return { type: "allow" };
        }
        return {
          type: "deny",
          message: "User did not approve this MCP tool call.",
        };
      } finally {
        options.prompt.onPromptEnd();
      }
    },
  };
}
