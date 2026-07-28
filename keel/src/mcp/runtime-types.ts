import type {
  McpToolExposureSnapshot,
  McpToolInvocation,
  ToolJsonValue,
} from "../tools/tool-call.ts";
import type { ToolOutputArtifact } from "../tools/types.ts";
import type { McpConnection, McpServerEndpoint } from "./discovery.ts";
import type { McpProviderSchemaTarget } from "./provider-schema.ts";

export interface McpSearchRequest {
  readonly query: string;
  readonly server?: string;
  readonly tool?: string;
  readonly limit?: number;
  readonly refresh?: boolean;
}

export type McpSearchResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly content: string };

export interface McpPermissionRequest {
  readonly origin: string;
  readonly serverId: string;
  readonly rawToolName: string;
  readonly arguments: Readonly<Record<string, ToolJsonValue>>;
  readonly signal: AbortSignal;
}

type McpPermissionDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly message: string };

export interface McpPermissionPolicy {
  readonly review: (
    request: McpPermissionRequest,
  ) => McpPermissionDecision | Promise<McpPermissionDecision>;
}

interface McpToolFilterRequest {
  readonly serverId: string;
  readonly rawToolName: string;
}

export interface McpToolFilterPolicy {
  readonly allows: (request: McpToolFilterRequest) => boolean;
}

export interface McpConnectionFactory {
  readonly connect: (
    server: McpServerEndpoint,
    signal: AbortSignal,
  ) => Promise<McpConnection>;
}

export interface McpPreservedToolResult {
  readonly origin: "external";
  readonly trustedEvidence: false;
  readonly serverId: string;
  readonly rawToolName: string;
  readonly value: ToolJsonValue;
  readonly valueBytes: number;
  readonly valueSha256: string;
  readonly valueTruncated?: true;
}

interface IdentifiedMcpToolRuntimeResult {
  readonly identity: "identified";
  readonly content: string;
  readonly ok: boolean;
  readonly sourceTruncated?: boolean;
  readonly artifact?: ToolOutputArtifact;
  readonly preserved: McpPreservedToolResult;
}

interface UnidentifiedMcpToolRuntimeResult {
  readonly identity: "unidentified";
  readonly content: string;
  readonly ok: false;
}

export type McpToolRuntimeResult =
  | IdentifiedMcpToolRuntimeResult
  | UnidentifiedMcpToolRuntimeResult;

export interface McpRuntime {
  readonly prepareTurn: (
    schemaTarget: McpProviderSchemaTarget,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly exposureSnapshot: () => McpToolExposureSnapshot;
  readonly search: (
    request: McpSearchRequest,
    signal: AbortSignal,
  ) => Promise<McpSearchResult>;
  readonly execute: (
    toolCall: McpToolInvocation,
    signal: AbortSignal,
  ) => Promise<McpToolRuntimeResult>;
  readonly close: () => Promise<void>;
}
