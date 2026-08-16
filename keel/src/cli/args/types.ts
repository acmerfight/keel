import type { AgentPolicyConfiguration } from "../../core/agent-policy.ts";
import type { ApiKeyProviderId, ProviderId } from "../../core/provider-id.ts";
import type { SessionGoalBudget } from "../../core/session-goal.ts";
import type { BashMode } from "../../permissions/bash.ts";
import type { SessionToolEffectRecoveryPolicy } from "../session-store.ts";

export interface EvalRunCliArgs {
  readonly command: "eval";
  readonly mode: "run";
  readonly suiteDir: string;
  readonly outFile: string;
  readonly transcriptDir?: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly check: boolean;
}

export interface EvalCompareCliArgs {
  readonly command: "eval";
  readonly mode: "compare";
  readonly baseFile: string;
  readonly headFile: string;
}

export type EvalCliArgs = EvalRunCliArgs | EvalCompareCliArgs;

export interface DoctorCliArgs {
  readonly command: "doctor";
  readonly offline: boolean;
  readonly providerId?: ProviderId;
  readonly model?: string;
}

export type AuthCliArgs =
  | {
      readonly command: "auth";
      readonly mode: "login";
      readonly providerId: ApiKeyProviderId;
    }
  | {
      readonly command: "auth";
      readonly mode: "logout";
      readonly providerId: ApiKeyProviderId;
    }
  | {
      readonly command: "auth";
      readonly mode: "status";
    };

export type ConfigCliArgs =
  | {
      readonly command: "config";
      readonly mode: "set-provider";
      readonly providerId: ProviderId;
      readonly model?: string;
      readonly baseUrl?: string;
    }
  | {
      readonly command: "config";
      readonly mode: "show";
    };

export type McpCliArgs =
  | {
      readonly command: "mcp";
      readonly mode: "add";
      readonly url: string;
      readonly name?: string;
      readonly allowPrivateNetwork: boolean;
      readonly allowTools: readonly string[];
      readonly denyTools: readonly string[];
    }
  | {
      readonly command: "mcp";
      readonly mode: "list";
    }
  | {
      readonly command: "mcp";
      readonly mode: "status" | "doctor";
      readonly serverId?: string;
    }
  | {
      readonly command: "mcp";
      readonly mode: "login";
      readonly serverId: string;
      readonly clientRegistration:
        | { readonly kind: "discovered" }
        | {
            readonly kind: "pre-registered";
            readonly clientId: string;
            readonly withClientSecret: boolean;
          };
    }
  | {
      readonly command: "mcp";
      readonly mode: "logout";
      readonly serverId: string;
    }
  | {
      readonly command: "mcp";
      readonly mode: "enable";
      readonly serverId: string;
    }
  | {
      readonly command: "mcp";
      readonly mode: "disable";
      readonly serverId: string;
    }
  | {
      readonly command: "mcp";
      readonly mode: "remove";
      readonly serverId: string;
    }
  | {
      readonly command: "mcp";
      readonly mode: "approvals-list";
    }
  | {
      readonly command: "mcp";
      readonly mode: "approvals-revoke";
      readonly index: number;
    }
  | {
      readonly command: "mcp";
      readonly mode: "approvals-clear";
    };

export interface SetupCliArgs {
  readonly command: "setup";
  readonly providerId: ApiKeyProviderId;
  readonly offline: boolean;
  readonly model?: string;
  readonly baseUrl?: string;
}

type UndoCliArgs =
  | {
      readonly command: "undo";
      readonly mode: "restore" | "list";
    }
  | {
      readonly command: "undo";
      readonly mode: "restore-through";
      readonly checkpointIndex: number;
    };

interface SessionsListCliArgs {
  readonly command: "sessions";
  readonly mode: "list";
}

export interface SessionsForkCliArgs {
  readonly command: "sessions";
  readonly mode: "fork";
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly forkBeforeMessage?: string;
}

export interface SessionsShowCliArgs {
  readonly command: "sessions";
  readonly mode: "show";
  readonly sessionId: string;
  readonly timelineLimit: number | null;
}

export interface SessionsRepairCliArgs {
  readonly command: "sessions";
  readonly mode: "repair";
  readonly sessionId: string;
  readonly strategy: "truncate-incomplete-tail";
}

export type SessionsCliArgs =
  | SessionsListCliArgs
  | SessionsForkCliArgs
  | SessionsShowCliArgs
  | SessionsRepairCliArgs;

interface ArtifactsShowCliArgs {
  readonly command: "artifacts";
  readonly mode: "show";
  readonly ref: string;
}

type ArtifactsCliArgs = ArtifactsShowCliArgs;

export type ApprovalsCliArgs =
  | {
      readonly command: "approvals";
      readonly mode: "list";
    }
  | {
      readonly command: "approvals";
      readonly mode: "clear";
    }
  | {
      readonly command: "approvals";
      readonly mode: "revoke";
      readonly index: number;
    };

export type MemoryCliArgs =
  | {
      readonly command: "memory";
      readonly mode: "help";
    }
  | {
      readonly command: "memory";
      readonly mode: "add";
      readonly text: string;
      readonly reviewAfter: string | null;
      readonly expiresAt: string | null;
    }
  | {
      readonly command: "memory";
      readonly mode: "list";
      readonly all: boolean;
    }
  | {
      readonly command: "memory";
      readonly mode: "show";
      readonly id: string;
    }
  | {
      readonly command: "memory";
      readonly mode: "update";
      readonly id: string;
      readonly text: string;
      readonly reviewAfter: string | null;
      readonly expiresAt: string | null;
    }
  | {
      readonly command: "memory";
      readonly mode: "review";
      readonly due: boolean;
    }
  | {
      readonly command: "memory";
      readonly mode: "verify";
      readonly id: string;
    }
  | {
      readonly command: "memory";
      readonly mode: "forget";
      readonly id: string;
    }
  | {
      readonly command: "memory";
      readonly mode: "purge";
      readonly id: string;
    }
  | {
      readonly command: "memory";
      readonly mode: "clear";
      readonly confirmed: boolean;
      readonly purge: boolean;
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-extract";
      readonly sessionId: string;
      readonly maxCostUsd: number;
      readonly providerId: ProviderId | null;
      readonly model: string | null;
      readonly retry: boolean;
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-list";
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-show";
      readonly id: string;
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-reject";
      readonly id: string;
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-purge";
      readonly id: string;
      readonly purgeMemoryId: string | null;
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-edit";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-approve";
      readonly id: string;
      readonly conflictResolution:
        | { readonly type: "none" }
        | { readonly type: "keep" }
        | { readonly type: "supersede"; readonly memoryId: string };
    }
  | {
      readonly command: "memory";
      readonly mode: "candidates-clear";
      readonly confirmed: boolean;
      readonly purge: boolean;
      readonly purgeLinkedMemories: boolean;
    };

type RunCliCommonArgs = {
  readonly command: "run";
  readonly bashMode: BashMode;
  readonly skillsEnabled: boolean;
  readonly reportFile?: string;
  readonly memoryEnabled: boolean;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly skillNames?: readonly string[];
} & AgentPolicyConfiguration;

export type InteractiveSessionCliIntent =
  | { readonly kind: "automatic" }
  | { readonly kind: "ephemeral" }
  | { readonly kind: "create"; readonly sessionId: string }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "resume-latest" }
  | { readonly kind: "resume-pick" }
  | {
      readonly kind: "fork";
      readonly sourceSessionId: string;
      readonly targetSessionId: string;
      readonly beforeMessageId: string | null;
    };

type OneShotRunCliArgs = RunCliCommonArgs & {
  readonly mode: "one-shot";
  readonly userMessage: string;
  readonly transcriptFile: string | null;
};

type InteractiveRunCliArgs = RunCliCommonArgs & {
  readonly mode: "interactive";
  readonly session: InteractiveSessionCliIntent;
  readonly recoveryPolicy: SessionToolEffectRecoveryPolicy;
};

type ForkPointsRunCliArgs = RunCliCommonArgs & {
  readonly mode: "fork-points";
  readonly sessionId: string;
};

export type RunCliArgs =
  | OneShotRunCliArgs
  | InteractiveRunCliArgs
  | ForkPointsRunCliArgs;

interface GoalCliCommonArgs {
  readonly command: "goal";
  readonly bashMode: BashMode;
  readonly skillsEnabled: boolean;
  readonly memoryEnabled: boolean;
  readonly maxCostUsd?: number;
  readonly reportFile?: string;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly skillNames?: readonly string[];
}

type GoalResumeSessionCliArg =
  | {
      readonly kind: "id";
      readonly sessionId: string;
    }
  | {
      readonly kind: "latest";
    };

interface GoalLaunchCliArgs extends GoalCliCommonArgs {
  readonly mode: "launch";
  readonly objective: string;
  readonly criterion:
    | {
        readonly kind: "command";
        readonly command: string;
        readonly verificationTimeoutMs?: number;
      }
    | {
        readonly kind: "assertion";
        readonly assertion: string;
      };
  readonly budget: SessionGoalBudget;
  readonly sessionId?: string;
}

interface GoalResumeCliArgs extends GoalCliCommonArgs {
  readonly mode: "resume";
  readonly budget: SessionGoalBudget;
  readonly resumeSession: GoalResumeSessionCliArg;
}

export type GoalCliArgs = GoalLaunchCliArgs | GoalResumeCliArgs;

export type SkillsCliArgs =
  | { readonly command: "skills"; readonly mode: "doctor" | "list" }
  | {
      readonly command: "skills";
      readonly mode: "configure";
      readonly action: "enable" | "disable";
      readonly target:
        | { readonly kind: "all" }
        | { readonly kind: "skill"; readonly lookup: string };
    };

export type CliArgs =
  | { readonly command: "help" }
  | AuthCliArgs
  | ConfigCliArgs
  | McpCliArgs
  | SetupCliArgs
  | DoctorCliArgs
  | UndoCliArgs
  | SkillsCliArgs
  | ArtifactsCliArgs
  | ApprovalsCliArgs
  | MemoryCliArgs
  | SessionsCliArgs
  | EvalCliArgs
  | GoalCliArgs
  | RunCliArgs;
