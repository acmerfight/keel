import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
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
const TOOL_OUTPUT_ARTIFACT_RETENTION_DAYS = 30;
const TOOL_OUTPUT_ARTIFACT_RETENTION_MS =
  TOOL_OUTPUT_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface ToolOutputArtifactStoreOptions {
  readonly runtime: SessionStoreRuntime;
  readonly scope: string;
}

interface ParsedToolOutputArtifactRef {
  readonly scope: string;
  readonly id: string;
}

function isValidArtifactSegment(kind: string, value: string): boolean {
  const pattern =
    kind === "scope" ? ARTIFACT_SCOPE_PATTERN : ARTIFACT_ID_PATTERN;
  return (
    pattern.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..")
  );
}

function validateArtifactSegment(kind: string, value: string): void {
  if (!isValidArtifactSegment(kind, value)) {
    throw new Error(
      `invalid artifact ${kind} "${value}". Use letters, numbers, dots, dashes, or underscores.`,
    );
  }
}

function artifactRoot(runtime: SessionStoreRuntime): string {
  return join(sessionHome(runtime), "artifacts", "tool-output");
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function listDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
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
  /* v8 ignore next 3: TOOL_OUTPUT_REF_PATTERN has required capture groups when a match exists. */
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
    `retention: stored under KEEL_HOME artifacts for ${TOOL_OUTPUT_ARTIFACT_RETENTION_DAYS} days by default or until manual removal`,
    "atRestPolicy: raw unredacted tool output; protect KEEL_HOME accordingly",
    "---",
    input.saveInput.content,
  ].join("\n");
}

export async function cleanupExpiredToolOutputArtifacts(options: {
  readonly runtime: SessionStoreRuntime;
}): Promise<void> {
  const root = artifactRoot(options.runtime);
  const cutoffMs = options.runtime.now() - TOOL_OUTPUT_ARTIFACT_RETENTION_MS;
  try {
    const scopes = await listDirectoryEntries(root);
    for (const scopeEntry of scopes) {
      if (
        !scopeEntry.isDirectory() ||
        !isValidArtifactSegment("scope", scopeEntry.name)
      ) {
        continue;
      }
      const scopeDirectory = join(root, scopeEntry.name);
      const artifacts = await listDirectoryEntries(scopeDirectory);
      for (const artifactEntry of artifacts) {
        if (!artifactEntry.isFile() || !artifactEntry.name.endsWith(".txt")) {
          continue;
        }
        const id = artifactEntry.name.slice(0, -".txt".length);
        if (!isValidArtifactSegment("id", id)) {
          continue;
        }
        const artifactFile = join(scopeDirectory, artifactEntry.name);
        try {
          const artifactStats = await stat(artifactFile);
          if (artifactStats.mtimeMs < cutoffMs) {
            await rm(artifactFile, { force: true });
          }
        } catch {}
      }
      try {
        await rmdir(scopeDirectory);
      } catch {}
    }
  } catch {
    return;
  }
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
    exists: async (ref: string): Promise<boolean> => {
      const parsed = parseToolOutputArtifactRef(ref);
      if (parsed === null) {
        return false;
      }
      try {
        const artifactStats = await stat(artifactPath(options.runtime, parsed));
        return artifactStats.isFile();
      } catch {
        return false;
      }
    },
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
        /* v8 ignore next 3: fs/promises rejects with Error instances in supported Node runtimes. */
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
    /* v8 ignore next 3: fs/promises rejects with Error instances in supported Node runtimes. */
    const reason =
      error instanceof Error ? error.message : "unknown storage error";
    return {
      ok: false,
      message: `Error: cannot read artifact ${options.ref}: ${reason}`,
    };
  }
}
