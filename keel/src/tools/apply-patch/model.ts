import type { ProjectInstructionVisibilityState } from "../scoped-project-instructions.ts";
import type { FileIdentity } from "../workspace-path.ts";

export interface ExecuteApplyPatchOptions {
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
  readonly projectInstructions?: ProjectInstructionVisibilityState;
  readonly recordCheckpoint?: boolean;
}

export interface ValidatedUpdateTarget {
  readonly targetPath: string;
  readonly mode: number;
}

export type GitRegularFileMode = 0o644 | 0o755;

export interface ParsedPatchModeChange {
  readonly oldMode: GitRegularFileMode;
  readonly newMode: GitRegularFileMode;
}

export interface PreparedPatchModeChange {
  readonly beforeMode: number;
  readonly afterMode: number;
}

export type ParsedPatchOperation =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly lines: readonly string[];
      readonly mode: GitRegularFileMode | null;
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly movePath: string | null;
      readonly hunks: readonly ParsedPatchHunk[];
      readonly modeChange: ParsedPatchModeChange | null;
    }
  | {
      readonly kind: "copy";
      readonly sourcePath: string;
      readonly path: string;
      readonly hunks: readonly ParsedPatchHunk[];
      readonly modeChange: ParsedPatchModeChange | null;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly expectedContent: string | null;
      readonly mode: GitRegularFileMode | null;
    };

export interface ParsedPatchHunk {
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

export type PreparedPatchOperation =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly resolvedTargetPath: string;
      readonly parentPath: string;
      readonly afterContent: string;
      readonly mode: GitRegularFileMode | null;
    }
  | {
      readonly kind: "copy";
      readonly sourcePath: string;
      readonly path: string;
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly resolvedTargetPath: string;
      readonly parentPath: string;
      readonly afterContent: string;
      readonly mode: number;
      readonly modeChange: PreparedPatchModeChange | null;
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly mode: number;
      readonly rollbackMode: number;
      readonly modeChange: PreparedPatchModeChange | null;
    }
  | {
      readonly kind: "move";
      readonly path: string;
      readonly movePath: string;
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly mode: number;
      readonly rollbackMode: number;
      readonly modeChange: PreparedPatchModeChange | null;
      readonly targetIdentity: FileIdentity;
      readonly destinationTargetPath: string;
      readonly destinationResolvedTargetPath: string;
      readonly destinationParentPath: string;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly beforeContent: string;
      readonly mode: number;
      readonly targetIdentity: FileIdentity;
    };

export type AppliedPatchOperation =
  | (Extract<PreparedPatchOperation, { readonly kind: "add" | "copy" }> & {
      readonly appliedIdentity: FileIdentity;
      readonly createdParentDirectories: readonly string[];
    })
  | (Extract<PreparedPatchOperation, { readonly kind: "update" }> & {
      readonly appliedIdentity: FileIdentity;
    })
  | (Extract<PreparedPatchOperation, { readonly kind: "delete" }> & {
      readonly appliedIdentity: FileIdentity;
    })
  | (Extract<PreparedPatchOperation, { readonly kind: "move" }> & {
      readonly destinationIdentity: FileIdentity;
      readonly createdDestinationParentDirectories: readonly string[];
    });
