import type { ApiKeyProviderId, ProviderId } from "../../core/provider-id.ts";
import type { BashMode } from "../../permissions/bash.ts";

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

export type SessionsCliArgs =
  | SessionsListCliArgs
  | SessionsForkCliArgs
  | SessionsShowCliArgs;

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

export interface RunCliArgs {
  readonly command: "run";
  readonly bashMode: BashMode;
  readonly userMessage?: string;
  readonly maxCostUsd?: number;
  readonly reportFile?: string;
  readonly transcriptFile?: string;
  readonly ephemeral: boolean;
  readonly sessionId?: string;
  readonly resumeSession?: ResumeSessionCliArg;
  readonly forkSessionId?: string;
  readonly forkBeforeMessage?: string;
  readonly forkPoints?: boolean;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly skillName?: string;
}

type ResumeSessionCliArg =
  | {
      readonly kind: "id";
      readonly sessionId: string;
    }
  | {
      readonly kind: "latest";
    };

export type CliArgs =
  | { readonly command: "help" }
  | AuthCliArgs
  | ConfigCliArgs
  | SetupCliArgs
  | DoctorCliArgs
  | UndoCliArgs
  | { readonly command: "skills" }
  | ArtifactsCliArgs
  | ApprovalsCliArgs
  | SessionsCliArgs
  | EvalCliArgs
  | RunCliArgs;
