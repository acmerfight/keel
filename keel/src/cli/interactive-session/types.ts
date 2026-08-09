import type { ContextCompactionOptions } from "../../agent/context-compaction.ts";
import type { AgentEvent, CostReport } from "../../agent/events.ts";
import type { ProjectInstructions } from "../../agent/prompt.ts";
import type { SessionMessage } from "../../agent/session-message.ts";
import type {
  AbortableToolOutputArtifactStore,
  ToolOutputArtifactsOptions,
} from "../../agent/tool-output-artifacts.ts";
import type { DelegatingAgentPolicy } from "../../core/agent-policy.ts";
import type { CostModel } from "../../core/cost.ts";
import type { ModelMetadata } from "../../core/model-metadata.ts";
import type { SessionGoal } from "../../core/session-goal.ts";
import type { SessionTaskProgress } from "../../core/task-progress.ts";
import type {
  UndoProtectionSummary,
  UndoProtectionTracker,
} from "../../core/undo-protection.ts";
import type { LLMProvider, Usage } from "../../llm/types.ts";
import type {
  McpConnectionFactory,
  McpLifecyclePolicy,
} from "../../mcp/runtime-types.ts";
import type {
  BashApprovalGrant,
  BashMode,
  BashProjectApprovalGrant,
  SessionBashPermissionPolicy,
} from "../../permissions/bash.ts";
import type {
  SkillActivationCapability,
  SkillActivationRecord,
  SkillDescriptor,
  SkillLifecycleState,
  WorkflowSkill,
} from "../../skills/model.ts";
import type {
  AgentMemoryProposalCapability,
  AgentMemoryRuntime,
} from "../../tools/memory.ts";
import type { AgentTreeHistory } from "../agent-tree-store.ts";
import type { SessionForkPoints } from "../fork-points.ts";
import type { McpServerConfig } from "../mcp-config.ts";
import type { ModelSource, ProviderSelection } from "../provider-config.ts";
import type { RunReportMemory } from "../report.ts";
import type {
  AgentEventReportRecorder,
  RunReportModelOperation,
  RunReportTask,
} from "../report-events.ts";
import type { SessionPickerView } from "../session-catalog-format.ts";
import type {
  SessionModelSelection,
  SessionPersistenceReason,
  SessionQueuedInput,
} from "../session-store.ts";
import type { InteractiveDiffInspection } from "./diff-inspection.ts";
import type { InteractiveLineInput } from "./line-reader.ts";

export type { ProviderSelection } from "../provider-config.ts";

export type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
export type EndEventWithCost = EndEvent & { readonly cost: CostReport };

export interface InteractiveSessionArgs {
  readonly bashMode: BashMode;
  readonly maxCostUsd?: number;
  readonly reportFile?: string;
}

export interface InteractiveInvocationAccounting {
  readonly usage: Usage;
  readonly agentLoopTurns: number;
  readonly promptTurnAttempted: boolean;
  readonly endObserved: boolean;
  readonly costUsd: number;
  readonly costBudgetLimited: boolean;
  readonly stopReason: string;
}

export interface InteractiveInvocationState {
  readonly accounting: InteractiveInvocationAccounting;
  readonly undoProtection: UndoProtectionTracker;
  readonly explicitSkillActivations: readonly SkillActivationRecord[];
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

export interface SavedInteractiveSession {
  readonly kind: "saved";
  readonly id: string;
  readonly resumeAvailable: () => boolean;
  readonly reserveMessageId: () => string;
  readonly persistQueuedInput: (input: {
    readonly sequence: number;
    readonly line: string;
  }) => SessionQueuedInput;
  readonly consumeQueuedInputs: (inputIds: readonly string[]) => void;
  readonly persistMessages: (request: {
    readonly messages: readonly SessionMessage[];
    readonly reason: SessionPersistenceReason;
    readonly consumedInputIds: readonly string[];
    readonly skillState: SkillLifecycleState | null;
    readonly reservedMessageIds: readonly {
      readonly message: SessionMessage;
      readonly id: string;
    }[];
  }) => void;
  readonly persistTitle: (titleRecord: {
    readonly title: string;
    readonly consumedInputIds: readonly string[];
  }) => string;
  readonly persistGoal: (update: {
    readonly goal: SessionGoal | null;
    readonly consumedInputIds: readonly string[];
  }) => SessionGoal | undefined;
  readonly persistTaskProgress: (update: {
    readonly taskProgress: SessionTaskProgress;
    readonly messageOrdinal: number;
  }) => void;
  readonly persistModelSwitch: (switchRecord: {
    readonly from: SessionModelSelection | null;
    readonly to: SessionModelSelection;
    readonly consumedInputIds: readonly string[];
  }) => void;
  readonly persistSkillState: (state: SkillLifecycleState) => void;
  readonly fork: (request: InteractiveForkSessionRequest) => string;
  readonly listForkPoints: () => SessionForkPoints;
  readonly persistBashApprovalGrant: (grant: BashApprovalGrant) => void;
  readonly persistBashApprovalRevoked: (revocation: {
    readonly grant: BashApprovalGrant;
    readonly consumedInputIds: readonly string[];
  }) => void;
  readonly persistBashApprovalsCleared: (clear: {
    readonly consumedInputIds: readonly string[];
  }) => void;
}

type EnabledInteractiveMemoryRuntime =
  AgentMemoryRuntime<AgentMemoryProposalCapability> & {
    readonly status: () => RunReportMemory;
  };

export type InteractiveMemoryRuntime =
  | {
      readonly kind: "disabled";
      readonly status: () => RunReportMemory;
    }
  | EnabledInteractiveMemoryRuntime;

type NonReviewedInteractiveMemoryRuntime = Exclude<
  InteractiveMemoryRuntime,
  { readonly kind: "reviewed" }
>;

export interface InteractiveActiveSessionState {
  readonly title?: string;
  readonly goal?: SessionGoal;
  readonly messages: readonly SessionMessage[];
  readonly taskProgress: SessionTaskProgress;
  readonly modelSelection?: SessionModelSelection;
  readonly modelSwitchCount: number;
  readonly queuedInputs: readonly SessionQueuedInput[];
  readonly bashApprovalGrants: readonly BashApprovalGrant[];
}

export interface ReviewedInteractiveActiveSession {
  readonly kind: "saved";
  readonly persistence: SavedInteractiveSession;
  readonly state: InteractiveActiveSessionState;
  readonly memory: Extract<
    InteractiveMemoryRuntime,
    { readonly kind: "reviewed" }
  >;
}

export type InteractiveActiveSession =
  | {
      readonly kind: "ephemeral";
      readonly state: InteractiveActiveSessionState;
      readonly memory: NonReviewedInteractiveMemoryRuntime;
    }
  | {
      readonly kind: "saved";
      readonly persistence: SavedInteractiveSession;
      readonly state: InteractiveActiveSessionState;
      readonly memory: NonReviewedInteractiveMemoryRuntime;
    }
  | ReviewedInteractiveActiveSession;

export type InteractiveSkillRuntime =
  | { readonly kind: "empty" }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    }
  | {
      readonly kind: "managed";
      readonly activation: SkillActivationCapability;
      readonly implicitSkills: readonly SkillDescriptor[];
      readonly loadExplicit: (lookup: string) => WorkflowSkill;
      readonly initialActivationRecords: readonly SkillActivationRecord[];
    };

interface InteractiveSessionOptionsBase {
  readonly activeSession: InteractiveActiveSession;
  readonly cliArgs: InteractiveSessionArgs;
  readonly workspace: string;
  readonly hiddenWorkspacePaths?: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly projectInstructions?: ProjectInstructions;
  readonly skills: InteractiveSkillRuntime;
  readonly mcp?: {
    readonly servers: readonly [
      McpServerConfig,
      ...(readonly McpServerConfig[]),
    ];
    readonly connectionFactory: McpConnectionFactory;
    readonly lifecycle: McpLifecyclePolicy;
    readonly canPrompt: boolean;
    readonly approvalRuntime: {
      readonly env: (key: string) => string | undefined;
    };
  };
  readonly configuredModelSelection?: ProviderSelection;
  readonly initialInputLines?: readonly string[];
  readonly onInitialInputLinesAdmitted?: () => void;
  readonly projectRoot?: string;
  readonly initialProjectBashApprovalGrants?: readonly BashProjectApprovalGrant[];
  readonly bashPermission?: SessionBashPermissionPolicy;
  readonly goalAutomaticContinuationTurnLimit?: number;
  readonly reportRecorder?: AgentEventReportRecorder;
  readonly priorExplicitSkillActivations?: readonly SkillActivationRecord[];
  readonly undoProtection?: UndoProtectionTracker;
  readonly initialInvocationAccounting?: InteractiveInvocationAccounting;
  readonly sessionPicker?: () => SessionPickerView;
  readonly exitOnTurnAbort?: boolean;
  readonly now?: () => number;
  readonly persistProjectBashApprovalGrant?: (
    grant: BashProjectApprovalGrant,
  ) => void;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly agentHistory?: AgentTreeHistory;
  readonly delegation?: {
    readonly policy: DelegatingAgentPolicy;
    readonly transcriptStore: AbortableToolOutputArtifactStore;
    readonly maxCostUsd: number;
  };
  readonly input: NodeJS.ReadableStream;
  readonly lineInput?: InteractiveLineInput;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly renderDiffReview?: (inspection: InteractiveDiffInspection) => void;
  readonly renderPrompt?: () => void;
  readonly acceptInput?: () => void;
  readonly closePrompt?: () => void;
  readonly setComposerMode?: (mode: InteractiveComposerMode) => void;
  readonly renderSubmittedInput?: (
    value: string,
    disposition: InteractiveInputDisposition,
  ) => void;
  readonly setGoalStatus?: (text: string | null) => void;
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
  readonly formatCostReport: (cost: CostReport) => string;
}

export type InteractiveSessionOptions = InteractiveSessionOptionsBase;

export type InteractiveComposerMode = "approval" | "queue" | "ready" | "steer";

export type InteractiveInputDisposition =
  | "approve"
  | "keel"
  | "queue"
  | "steer/next";

interface InteractiveReportModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly agentLoopTurns: number;
  readonly usage: Usage;
  readonly costUsd: number;
}

export interface InteractiveSessionResult {
  readonly invocationState: InteractiveInvocationState;
  readonly goal?: SessionGoal;
  readonly switchSession?: {
    readonly targetSessionId: string;
    readonly lineInput: InteractiveLineInput;
    readonly initialInputLines: readonly string[];
    readonly sourceInputIds: readonly string[];
  };
  readonly report?: {
    readonly tasks: readonly RunReportTask[];
    readonly modelsUsed: readonly {
      readonly provider: string;
      readonly model: string;
    }[];
    readonly usageByModel: readonly InteractiveReportModelUsage[];
    readonly modelOperations: readonly RunReportModelOperation[];
    readonly modelOperationCount: number;
    readonly providerRequestAttemptCount: number;
    readonly end: EndEventWithCost;
    readonly skillCatalog: {
      readonly exposed: number;
      readonly omitted: number;
      readonly total: number;
      readonly budgetChars: number;
      readonly usedChars: number;
    };
    readonly explicitSkillActivations: readonly SkillActivationRecord[];
    readonly undoProtection: UndoProtectionSummary;
  };
}
