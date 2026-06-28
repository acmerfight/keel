import type { ProjectInstructionVisibilityState } from "../scoped-project-instructions.ts";
import type { FileIdentity } from "../workspace-path.ts";

export interface ExecuteApplyPatchOptions {
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
  readonly projectInstructions?: ProjectInstructionVisibilityState;
}

export interface ValidatedUpdateTarget {
  readonly targetPath: string;
  readonly mode: number;
}

export type ParsedPatchOperation =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly movePath: string | null;
      readonly hunks: readonly ParsedPatchHunk[];
    }
  | {
      readonly kind: "delete";
      readonly path: string;
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
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly mode: number;
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
  | (Extract<PreparedPatchOperation, { readonly kind: "add" }> & {
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
