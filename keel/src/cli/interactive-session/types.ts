import type { ContextCompactionOptions } from "../../agent/context-compaction.ts";
import type { AgentEvent, CostReport } from "../../agent/events.ts";
import type { ProjectInstructions } from "../../agent/prompt.ts";
import type { ToolOutputArtifactsOptions } from "../../agent/tool-output-artifacts.ts";
import type { CostModel } from "../../core/cost.ts";
import type { ModelMetadata } from "../../core/model-metadata.ts";
import type { SessionGoal } from "../../core/session-goal.ts";
import type { SessionTaskProgress } from "../../core/task-progress.ts";
import type { UndoProtectionSummary } from "../../core/undo-protection.ts";
import type { LLMProvider, Message, Usage } from "../../llm/types.ts";
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
  AgentMemoryMutationCapability,
  AgentMemoryProposalCapability,
} from "../../tools/memory.ts";
import type { SessionForkPoints } from "../fork-points.ts";
import type { ModelSource, ProviderSelection } from "../provider-config.ts";
import type { RunReportMemory } from "../report.ts";
import type {
  AgentEventReportRecorder,
  RunReportModelOperation,
  RunReportTask,
} from "../report-events.ts";
import type {
  SessionModelSelection,
  SessionPersistenceReason,
  SessionQueuedInput,
} from "../session-store.ts";
import type { InteractiveLineInput } from "./line-reader.ts";

export type { ProviderSelection } from "../provider-config.ts";

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
    readonly messages: readonly Message[];
    readonly reason: SessionPersistenceReason;
    readonly consumedInputIds: readonly string[];
    readonly skillState: SkillLifecycleState | null;
    readonly reservedMessageIds: readonly {
      readonly message: Message;
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

export type InteractiveSession =
  | { readonly kind: "ephemeral" }
  | SavedInteractiveSession;

export type InteractiveMemoryRuntime =
  | {
      readonly kind: "disabled";
      readonly status: () => RunReportMemory;
    }
  | {
      readonly kind: "direct";
      readonly prompt: () => string;
      readonly mutation: AgentMemoryMutationCapability;
      readonly status: () => RunReportMemory;
    }
  | {
      readonly kind: "reviewed";
      readonly prompt: () => string;
      readonly mutation: AgentMemoryMutationCapability;
      readonly proposal: AgentMemoryProposalCapability;
      readonly status: () => RunReportMemory;
    };

type NonReviewedInteractiveMemoryRuntime = Exclude<
  InteractiveMemoryRuntime,
  { readonly kind: "reviewed" }
>;

export interface ReviewedInteractiveSessionMemoryBinding {
  readonly session: SavedInteractiveSession;
  readonly memory: Extract<
    InteractiveMemoryRuntime,
    { readonly kind: "reviewed" }
  >;
}

export type InteractiveSessionMemoryBinding =
  | {
      readonly session: InteractiveSession;
      readonly memory: NonReviewedInteractiveMemoryRuntime;
    }
  | ReviewedInteractiveSessionMemoryBinding;

interface InteractiveSessionOptionsBase {
  readonly cliArgs: InteractiveSessionArgs;
  readonly workspace: string;
  readonly hiddenWorkspacePaths?: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly projectInstructions?: ProjectInstructions;
  readonly workflowSkills?: readonly WorkflowSkill[];
  readonly skillCatalog?: readonly SkillDescriptor[];
  readonly skillActivation?: SkillActivationCapability;
  readonly skillUnavailableReason?: string;
  readonly initialSkillActivationRecords?: readonly SkillActivationRecord[];
  readonly activateExplicitSkill?: (lookup: string) => WorkflowSkill;
  readonly initialSessionTitle?: string;
  readonly initialSessionGoal?: SessionGoal;
  readonly initialMessages?: readonly Message[];
  readonly initialTaskProgress?: SessionTaskProgress;
  readonly initialModelSelection?: SessionModelSelection;
  readonly configuredModelSelection?: ProviderSelection;
  readonly initialModelSwitchCount?: number;
  readonly initialQueuedInputs?: readonly SessionQueuedInput[];
  readonly initialInputLines?: readonly string[];
  readonly initialBashApprovalGrants?: readonly BashApprovalGrant[];
  readonly projectRoot?: string;
  readonly initialProjectBashApprovalGrants?: readonly BashProjectApprovalGrant[];
  readonly bashPermission?: SessionBashPermissionPolicy;
  readonly goalAutomaticContinuationTurnLimit?: number;
  readonly reportRecorder?: AgentEventReportRecorder;
  readonly exitOnTurnAbort?: boolean;
  readonly now?: () => number;
  readonly persistProjectBashApprovalGrant?: (
    grant: BashProjectApprovalGrant,
  ) => void;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly input: NodeJS.ReadableStream;
  readonly lineInput?: InteractiveLineInput;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
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
  readonly formatCostReport: (cost: CostReport, maxUsd: number) => string;
}

export type InteractiveSessionOptions = InteractiveSessionOptionsBase &
  InteractiveSessionMemoryBinding;

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
  readonly goal?: SessionGoal;
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
