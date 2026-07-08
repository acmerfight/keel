import type { ContextCompactionOptions } from "../../agent/context-compaction.ts";
import type { AgentEvent, CostReport } from "../../agent/events.ts";
import type { ProjectInstructions, WorkflowSkill } from "../../agent/prompt.ts";
import type { ToolOutputArtifactsOptions } from "../../agent/tool-output-artifacts.ts";
import type { CostModel } from "../../core/cost.ts";
import type { ModelMetadata } from "../../core/model-metadata.ts";
import type { ProviderId } from "../../core/provider-id.ts";
import type { SessionTaskProgress } from "../../core/task-progress.ts";
import type { LLMProvider, Message, Usage } from "../../llm/types.ts";
import type {
  BashApprovalGrant,
  BashMode,
  BashProjectApprovalGrant,
} from "../../permissions/bash.ts";
import type { SessionForkPoints } from "../fork-points.ts";
import type { ModelSource, ProviderSelection } from "../provider-config.ts";
import type {
  SessionModelSelection,
  SessionPersistenceReason,
  SessionQueuedInput,
} from "../session-store.ts";

export type { ProviderSelection } from "../provider-config.ts";
export type { SessionPersistenceReason } from "../session-store.ts";

export type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
export type EndEventWithCost = EndEvent & { readonly cost: CostReport };

export interface InteractiveSessionArgs {
  readonly bashMode: BashMode;
  readonly maxCostUsd?: number;
  readonly reportFile?: string;
}

export interface InteractiveForkSessionRequest {
  readonly targetSessionId: string;
  readonly beforeMessageId?: string;
}

interface InteractiveResolvedProviderBase {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly modelMetadata?: ModelMetadata;
}

export type InteractiveResolvedProvider =
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "fake";
      readonly costModel: CostModel;
    })
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "deepseek";
      readonly costModel: CostModel | null;
      readonly modelSource: ModelSource;
    })
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "kimi";
      readonly costModel: CostModel | null;
      readonly modelSource: ModelSource;
    })
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "qwen";
      readonly costModel: CostModel | null;
      readonly modelSource: ModelSource;
    });

export interface InteractiveSessionOptions {
  readonly cliArgs: InteractiveSessionArgs;
  readonly workspace: string;
  readonly platform: NodeJS.Platform;
  readonly sessionId?: string;
  readonly projectInstructions?: ProjectInstructions;
  readonly workflowSkill?: WorkflowSkill;
  readonly initialSessionTitle?: string;
  readonly initialMessages?: readonly Message[];
  readonly initialTaskProgress?: SessionTaskProgress;
  readonly initialModelSelection?: SessionModelSelection;
  readonly configuredModelSelection?: ProviderSelection;
  readonly sessionResumeAvailable?: () => boolean;
  readonly initialModelSwitchCount?: number;
  readonly initialQueuedInputs?: readonly SessionQueuedInput[];
  readonly initialInputLines?: readonly string[];
  readonly initialBashApprovalGrants?: readonly BashApprovalGrant[];
  readonly projectRoot?: string;
  readonly initialProjectBashApprovalGrants?: readonly BashProjectApprovalGrant[];
  readonly persistProjectBashApprovalGrant?: (
    grant: BashProjectApprovalGrant,
  ) => void;
  readonly persistQueuedInput?: (input: {
    readonly sequence: number;
    readonly line: string;
  }) => SessionQueuedInput;
  readonly consumeQueuedInputs?: (inputIds: readonly string[]) => void;
  readonly persistSessionMessages?: (
    messages: readonly Message[],
    reason: SessionPersistenceReason,
    consumedInputIds: readonly string[],
  ) => void;
  readonly persistSessionTitle?: (titleRecord: {
    readonly title: string;
    readonly consumedInputIds: readonly string[];
  }) => string;
  readonly persistTaskProgress?: (update: {
    readonly taskProgress: SessionTaskProgress;
    readonly messageOrdinal: number;
  }) => void;
  readonly persistModelSwitch?: (switchRecord: {
    readonly from: SessionModelSelection | null;
    readonly to: SessionModelSelection;
    readonly consumedInputIds: readonly string[];
  }) => void;
  readonly forkSession?: (request: InteractiveForkSessionRequest) => string;
  readonly listForkPoints?: () => SessionForkPoints;
  readonly persistBashApprovalGrant?: (grant: BashApprovalGrant) => void;
  readonly persistBashApprovalRevoked?: (revocation: {
    readonly grant: BashApprovalGrant;
    readonly consumedInputIds: readonly string[];
  }) => void;
  readonly persistBashApprovalsCleared?: (clear: {
    readonly consumedInputIds: readonly string[];
  }) => void;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly input: NodeJS.ReadableStream;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly renderPrompt?: () => void;
  readonly acceptInput?: () => void;
  readonly closePrompt?: () => void;
  readonly onSigint: (handler: () => void) => void;
  readonly offSigint: (handler: () => void) => void;
  readonly setExitCode: (code: number) => void;
  readonly forceExit: (code: number) => never;
  readonly resolveProvider: (
    userMessage: string,
    selection?: ProviderSelection,
  ) => InteractiveResolvedProvider;
  readonly requireKnownCostModel: (
    resolved: InteractiveResolvedProvider,
  ) => CostModel;
  readonly printAgentEvents: (
    stream: AsyncIterable<AgentEvent>,
  ) => Promise<EndEvent | undefined>;
  readonly formatCostReport: (cost: CostReport, maxUsd: number) => string;
}

export interface InteractiveReportModelUsage {
  readonly provider: ProviderId;
  readonly model: string;
  readonly turns: number;
  readonly usage: Usage;
  readonly costUsd: number;
}

export interface InteractiveSessionResult {
  readonly report?: {
    readonly modelsUsed: readonly {
      readonly provider: ProviderId;
      readonly model: string;
    }[];
    readonly usageByModel: readonly InteractiveReportModelUsage[];
    readonly end: EndEventWithCost;
  };
}
