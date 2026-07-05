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
  ToolOutputArtifactReuseInput,
  ToolOutputArtifactReuseResult,
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
export const TOOL_OUTPUT_ARTIFACT_RETENTION_DESCRIPTION = `raw, unredacted tool output under KEEL_HOME artifacts for ${TOOL_OUTPUT_ARTIFACT_RETENTION_DAYS} days by default or until manual removal; inspect refs with keel artifacts show <ref>`;
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

interface ParsedArtifactContent {
  readonly metadata: ReadonlyMap<string, string>;
  readonly body: string;
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function utf8RoundTrip(content: string): string {
  return Buffer.from(content, "utf8").toString("utf8");
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
  const hash = sha256(input.saveInput.content);
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

function parseArtifactContent(content: string): ParsedArtifactContent | null {
  const separator = "\n---\n";
  const separatorIndex = content.indexOf(separator);
  if (separatorIndex === -1) {
    return null;
  }
  const metadata = new Map(
    Array.from(
      content.slice(0, separatorIndex).matchAll(/^([^:\n]+): (.*)$/gmu),
      (match) => [String(match[1]), String(match[2])] as const,
    ),
  );
  return {
    metadata,
    body: content.slice(separatorIndex + separator.length),
  };
}

function artifactMatchesReuseInput(
  parsed: ParsedArtifactContent,
  input: ToolOutputArtifactReuseInput,
): ToolOutputArtifactReuseResult {
  const contentChars = Number(parsed.metadata.get("contentChars"));
  const contentSha256 = parsed.metadata.get("sha256");
  const expectedChars = input.previewContent.length + input.omittedChars;
  const parsedBodySha256 =
    contentSha256 === undefined ? undefined : sha256(parsed.body);
  const contentHashMatches =
    contentSha256 !== undefined &&
    parsedBodySha256 === contentSha256 &&
    (input.contentSha256 === undefined ||
      input.contentSha256 === contentSha256);
  const previewMatches =
    input.previewKind === "prefix"
      ? parsed.body.startsWith(utf8RoundTrip(input.previewContent))
      : input.contentSha256 !== undefined;
  if (
    !Number.isSafeInteger(contentChars) ||
    contentChars !== expectedChars ||
    parsed.body.length !== contentChars ||
    parsed.metadata.get("ref") !== input.ref ||
    parsed.metadata.get("toolCallId") !== input.toolCallId ||
    parsed.metadata.get("sourceStatus") !== input.sourceStatus ||
    !contentHashMatches ||
    !previewMatches
  ) {
    return { status: "not_reusable" };
  }
  return { status: "reusable", contentSha256 };
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
    verifyReusable: async (
      input: ToolOutputArtifactReuseInput,
    ): Promise<ToolOutputArtifactReuseResult> => {
      const parsed = parseToolOutputArtifactRef(input.ref);
      /* v8 ignore next 3: generated markers validate refs before verification; malformed direct inputs safely miss. */
      if (parsed === null) {
        return { status: "not_reusable" };
      }
      try {
        const content = await readFile(
          artifactPath(options.runtime, parsed),
          "utf8",
        );
        const artifact = parseArtifactContent(content);
        if (artifact === null) {
          return { status: "not_reusable" };
        }
        return artifactMatchesReuseInput(artifact, input);
      } catch {
        return { status: "not_reusable" };
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
            savedAt: new Date(options.runtime.now()).toISOString(),
            saveInput: input,
          }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        return {
          status: "stored",
          ref,
          contentSha256: sha256(input.content),
        };
      } catch (error) {
        /* v8 ignore next 3: fs/promises rejects with Error instances in supported Node runtimes. */
        const reason =
          error instanceof Error ? error.message : "unknown storage error";
        return { status: "failed", reason };
      }
    },
    discard: async (ref: string): Promise<void> => {
      const parsed = parseToolOutputArtifactRef(ref);
      if (parsed === null) {
        return;
      }
      await rm(artifactPath(options.runtime, parsed), { force: true });
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
