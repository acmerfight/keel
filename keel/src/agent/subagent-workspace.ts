export interface SubagentWriteWorkspaceReference {
  readonly kind: "isolated_write";
  readonly leaseId: string;
  readonly baseCommit: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly workspaceRoot: string;
}

interface SubagentWritePatch {
  readonly content: string;
  readonly sourceTruncated: boolean;
  readonly summary: string;
}

export type SubagentWriteWorkspaceSettlement =
  | {
      readonly disposition: "preserved";
      readonly worktreePath: string;
      readonly patch: SubagentWritePatch;
    }
  | {
      readonly disposition: "cleanup_failed";
      readonly worktreePath: string | null;
      readonly patch: SubagentWritePatch | null;
      readonly error: string;
    };

export interface SubagentWriteWorkspaceLease {
  readonly reference: SubagentWriteWorkspaceReference;
  readonly verify: (workspaceRoot: string) => void;
  readonly settle: () => SubagentWriteWorkspaceSettlement;
}

type SubagentWriteWorkspaceActivation =
  | {
      readonly kind: "acquired";
      readonly lease: SubagentWriteWorkspaceLease;
    }
  | {
      readonly kind: "failed";
      readonly worktreePath: string | null;
      readonly error: string;
      readonly recovery: string;
    };

interface SubagentPreparedWriteWorkspace {
  readonly reference: SubagentWriteWorkspaceReference;
  readonly activate: () => SubagentWriteWorkspaceActivation;
}

type SubagentWriteWorkspacePreparation =
  | {
      readonly kind: "prepared";
      readonly workspace: SubagentPreparedWriteWorkspace;
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly recovery: string;
    };

type SubagentWriteWorkspaceReacquisition =
  | {
      readonly kind: "acquired";
      readonly lease: SubagentWriteWorkspaceLease;
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly recovery: string;
    };

export interface SubagentWriteWorkspaceRuntime {
  readonly prepare: (input: {
    readonly childRunId: string;
    readonly signal: AbortSignal;
  }) => SubagentWriteWorkspacePreparation;
  readonly reacquire: (input: {
    readonly childRunId: string;
    readonly previous: SubagentWriteWorkspaceReference;
    readonly signal: AbortSignal;
  }) => SubagentWriteWorkspaceReacquisition;
}

interface SubagentWriteWorkspaceResultBase {
  readonly kind: "isolated_write";
  readonly leaseId: string;
  readonly baseCommit: string;
  readonly branch: string;
}

type SubagentWriteWorkspaceFailureLocation =
  | {
      readonly worktreePath: null;
      readonly workspaceRoot: null;
    }
  | {
      readonly worktreePath: string;
      readonly workspaceRoot: string | null;
    };

type SubagentWriteWorkspaceFailurePatch =
  | {
      readonly patchRef: null;
      readonly patchSha256: null;
      readonly patchSourceTruncated: boolean;
    }
  | {
      readonly patchRef: string;
      readonly patchSha256: string;
      readonly patchSourceTruncated: boolean;
    };

export type SubagentWriteWorkspaceResult =
  | (SubagentWriteWorkspaceResultBase & {
      readonly disposition: "preserved";
      readonly worktreePath: string;
      readonly workspaceRoot: string;
      readonly patchSourceTruncated: boolean;
      readonly summary: string;
    } & (
        | {
            readonly patchRef: string;
            readonly patchSha256: string;
            readonly error: null;
          }
        | {
            readonly patchRef: null;
            readonly patchSha256: null;
            readonly error: string;
          }
      ))
  | (SubagentWriteWorkspaceResultBase &
      SubagentWriteWorkspaceFailureLocation &
      SubagentWriteWorkspaceFailurePatch & {
        readonly disposition: "cleanup_failed";
        readonly summary: string;
        readonly error: string;
      });
