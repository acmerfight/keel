import type { AgentId } from "../agent/subagent-lifecycle.ts";

interface AgentControlResult {
  readonly ok: boolean;
  readonly content: string;
}

interface AgentControlRequest {
  readonly id: AgentId;
  readonly signal: AbortSignal;
  readonly maxResultChars: number;
}

interface AgentSettlementRequest {
  readonly id: AgentId;
  readonly signal: AbortSignal;
}

interface AgentListRequest {
  readonly maxResultChars: number;
}

export interface AgentControlCapability {
  readonly list: (request: AgentListRequest) => AgentControlResult;
  readonly waitForSettlement: (
    request: AgentSettlementRequest,
  ) => Promise<void>;
  readonly wait: (request: AgentControlRequest) => Promise<AgentControlResult>;
  readonly cancel: (
    request: AgentControlRequest,
  ) => Promise<AgentControlResult>;
}
