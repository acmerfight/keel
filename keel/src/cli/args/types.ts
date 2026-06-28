import type { ProviderId } from "../../core/provider-id.ts";
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

export interface RunCliArgs {
  readonly command: "run";
  readonly bashMode: BashMode;
  readonly userMessage?: string;
  readonly maxCostUsd?: number;
  readonly reportFile?: string;
  readonly transcriptFile?: string;
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
  readonly forkSessionId?: string;
  readonly forkBeforeMessage?: string;
  readonly forkPoints?: boolean;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly skillName?: string;
}

export type CliArgs =
  | { readonly command: "help" }
  | DoctorCliArgs
  | { readonly command: "undo" }
  | { readonly command: "skills" }
  | SessionsCliArgs
  | EvalCliArgs
  | RunCliArgs;
