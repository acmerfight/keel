import type { FileRevision } from "./file-revision.ts";

export type FileRevisionStatus = "unread" | "current" | "changed";

export interface ReadBeforeEdit {
  readonly revisionStatus: (
    targetPath: string,
    currentRevision: FileRevision,
  ) => FileRevisionStatus;
}
