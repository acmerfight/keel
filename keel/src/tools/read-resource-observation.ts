import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { KeelError } from "../core/error.ts";
import type { ReadResourceObservation } from "../core/resource-observation.ts";
import { executeRead } from "./read.ts";
import type { ValidToolCall } from "./tool-call.ts";

type ReadToolCall = Extract<ValidToolCall, { readonly tool: "read" }>;

export type ReadResourceFreshnessStatus =
  | "matches"
  | "changed"
  | "missing"
  | "unverifiable";

export interface ReadResourceFreshness {
  readonly status: ReadResourceFreshnessStatus;
  readonly reason: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function targetPathDigest(workspace: string, targetPath: string): string {
  return sha256(relative(realpathSync(workspace), targetPath));
}

export function observeReadResource(input: {
  readonly workspace: string;
  readonly targetPath: string;
  readonly content: string;
}): ReadResourceObservation {
  return {
    kind: "read_projection",
    targetPathSha256: targetPathDigest(input.workspace, input.targetPath),
    contentSha256: sha256(input.content),
  };
}

function unavailableReadFreshness(error: unknown): ReadResourceFreshness {
  if (error instanceof KeelError) {
    if (error.code === "tool_file_not_found") {
      return {
        status: "missing",
        reason: "The observed file is now missing.",
      };
    }
    if (error.code === "tool_read_offset_out_of_range") {
      return {
        status: "changed",
        reason: "The observed read projection no longer exists in the file.",
      };
    }
  }
  return {
    status: "unverifiable",
    reason: "Runtime could not safely revalidate the observed file projection.",
  };
}

export function revalidateReadResource(input: {
  readonly workspace: string;
  readonly toolCall: ReadToolCall;
  readonly observation: ReadResourceObservation;
}): ReadResourceFreshness {
  try {
    const current = executeRead(input.workspace, input.toolCall.path, {
      offset: input.toolCall.offset,
      limit: input.toolCall.limit,
    });
    if (
      targetPathDigest(input.workspace, current.targetPath) !==
        input.observation.targetPathSha256 ||
      sha256(current.content) !== input.observation.contentSha256
    ) {
      return {
        status: "changed",
        reason:
          "The current file projection no longer matches the recorded read evidence.",
      };
    }
    return {
      status: "matches",
      reason: "The current file projection matches the recorded read evidence.",
    };
  } catch (error) {
    return unavailableReadFreshness(error);
  }
}
