import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactSaveResult,
  ToolOutputArtifactStore,
} from "../agent/tool-output-artifacts.ts";
import { type SessionStoreRuntime, sessionHome } from "./session-store.ts";

const ARTIFACT_SCOPE_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const TOOL_OUTPUT_REF_PATTERN =
  /^tool-output:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u;

interface ToolOutputArtifactStoreOptions {
  readonly runtime: SessionStoreRuntime;
  readonly scope: string;
}

interface ParsedToolOutputArtifactRef {
  readonly scope: string;
  readonly id: string;
}

function validateArtifactSegment(kind: string, value: string): void {
  const pattern =
    kind === "scope" ? ARTIFACT_SCOPE_PATTERN : ARTIFACT_ID_PATTERN;
  if (
    !pattern.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    throw new Error(
      `invalid artifact ${kind} "${value}". Use letters, numbers, dots, dashes, or underscores.`,
    );
  }
}

function artifactRoot(runtime: SessionStoreRuntime): string {
  return join(sessionHome(runtime), "artifacts", "tool-output");
}

function artifactDirectory(
  runtime: SessionStoreRuntime,
  scope: string,
): string {
  validateArtifactSegment("scope", scope);
  return join(artifactRoot(runtime), scope);
}

function artifactPath(
  runtime: SessionStoreRuntime,
  ref: ParsedToolOutputArtifactRef,
): string {
  validateArtifactSegment("scope", ref.scope);
  validateArtifactSegment("id", ref.id);
  return join(artifactRoot(runtime), ref.scope, `${ref.id}.txt`);
}

function toolOutputArtifactRef(scope: string, id: string): string {
  validateArtifactSegment("scope", scope);
  validateArtifactSegment("id", id);
  return `tool-output:${scope}/${id}`;
}

function parseToolOutputArtifactRef(
  ref: string,
): ParsedToolOutputArtifactRef | null {
  const match = TOOL_OUTPUT_REF_PATTERN.exec(ref);
  if (match === null) {
    return null;
  }
  const scope = match[1];
  const id = match[2];
  if (scope === undefined || id === undefined) {
    return null;
  }
  try {
    validateArtifactSegment("scope", scope);
    validateArtifactSegment("id", id);
  } catch {
    return null;
  }
  return { scope, id };
}

function artifactContent(input: {
  readonly ref: string;
  readonly id: string;
  readonly savedAt: string;
  readonly saveInput: ToolOutputArtifactSaveInput;
}): string {
  const hash = createHash("sha256")
    .update(input.saveInput.content)
    .digest("hex");
  return [
    `ref: ${input.ref}`,
    `id: ${input.id}`,
    `tool: ${input.saveInput.toolName}`,
    `toolCallId: ${input.saveInput.toolCallId}`,
    `purpose: ${input.saveInput.purpose}`,
    `sourceStatus: ${input.saveInput.sourceStatus}`,
    `contentChars: ${input.saveInput.content.length}`,
    `sha256: ${hash}`,
    `savedAt: ${input.savedAt}`,
    "retention: stored under KEEL_HOME artifacts until KEEL_HOME cleanup or manual removal",
    "---",
    input.saveInput.content,
  ].join("\n");
}

export function newToolOutputArtifactScope(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function toolOutputArtifactScopeForSession(sessionId: string): string {
  return `session-${sessionId}`;
}

export function createToolOutputArtifactStore(
  options: ToolOutputArtifactStoreOptions,
): ToolOutputArtifactStore {
  validateArtifactSegment("scope", options.scope);
  return {
    save: async (
      input: ToolOutputArtifactSaveInput,
    ): Promise<ToolOutputArtifactSaveResult> => {
      const directory = artifactDirectory(options.runtime, options.scope);
      const id = randomUUID();
      const ref = toolOutputArtifactRef(options.scope, id);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          join(directory, `${id}.txt`),
          artifactContent({
            ref,
            id,
            savedAt: new Date().toISOString(),
            saveInput: input,
          }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        return { status: "stored", ref };
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "unknown storage error";
        return { status: "failed", reason };
      }
    },
  };
}

function invalidToolOutputArtifactRefMessage(ref: string): string {
  return `Error: invalid artifact ref "${ref}". Use tool-output:<scope>/<id>.`;
}

export async function showToolOutputArtifact(options: {
  readonly runtime: SessionStoreRuntime;
  readonly ref: string;
}): Promise<
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly message: string }
> {
  const parsed = parseToolOutputArtifactRef(options.ref);
  if (parsed === null) {
    return {
      ok: false,
      message: invalidToolOutputArtifactRefMessage(options.ref),
    };
  }
  try {
    return {
      ok: true,
      content: await readFile(artifactPath(options.runtime, parsed), "utf8"),
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unknown storage error";
    return {
      ok: false,
      message: `Error: cannot read artifact ${options.ref}: ${reason}`,
    };
  }
}
