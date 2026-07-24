import { createHash, type Hash } from "node:crypto";

export interface FileRevision {
  readonly algorithm: "sha256";
  readonly digest: string;
}

export interface FileRevisionAccumulator {
  readonly update: (bytes: Uint8Array) => void;
  readonly finish: () => FileRevision;
}

export function createFileRevisionAccumulator(): FileRevisionAccumulator {
  const hash: Hash = createHash("sha256");
  return {
    update: (bytes) => {
      hash.update(bytes);
    },
    finish: () => ({
      algorithm: "sha256",
      digest: hash.digest("hex"),
    }),
  };
}

export function fileRevisionFromBytes(bytes: Uint8Array): FileRevision {
  const revision = createFileRevisionAccumulator();
  revision.update(bytes);
  return revision.finish();
}

export function sameFileRevision(
  left: FileRevision,
  right: FileRevision,
): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest;
}
