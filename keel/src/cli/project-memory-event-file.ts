import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../core/error.ts";
import {
  appendPrivateFile,
  createPrivateFile,
  PrivateStateError,
  readPrivateFile,
  readPrivateFileBuffer,
  removePrivateFile,
  replacePrivateFile,
  truncatePrivateFile,
} from "../core/private-state.ts";
import {
  type ProjectMemoryEvent,
  projectMemoryEventSchema,
} from "./project-memory-events.ts";

export class ProjectMemoryEventFileError extends Error {}

const PROJECT_MEMORY_EVENT_FILE_LABEL = "project memory event file";

function fail(message: string): never {
  throw new ProjectMemoryEventFileError(message);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Reflect.get(Object(error), "code") === code;
}

function unsafeProjectMemoryFile(path: string, error: unknown): never {
  fail(
    `Error: unsafe project memory path ${path}: expected a regular file: ${errorMessage(error)}`,
  );
}

function parseEvent(
  line: string,
  filePath: string,
  lineNumber: number,
): ProjectMemoryEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail(
      `Error: cannot read project memory ${filePath}: invalid JSON at line ${lineNumber}.`,
    );
  }
  const parsed = projectMemoryEventSchema.safeParse(value);
  if (!parsed.success) {
    fail(
      `Error: cannot read project memory ${filePath}: unsupported or invalid event at line ${lineNumber}.`,
    );
  }
  return parsed.data;
}

export function readProjectMemoryEventFile(
  filePath: string,
): readonly ProjectMemoryEvent[] {
  let content: string | null;
  try {
    content = readPrivateFile({
      path: filePath,
      label: PROJECT_MEMORY_EVENT_FILE_LABEL,
    });
  } catch (error) {
    return projectMemoryFileAccessError(filePath, "read", error);
  }
  if (content === null) return [];
  let completeContent = content;
  if (!content.endsWith("\n")) {
    const finalNewline = content.lastIndexOf("\n");
    const incompleteLine = content.slice(finalNewline + 1);
    completeContent = content.slice(0, finalNewline + 1);
    if (incompleteLine !== "") {
      try {
        const value: unknown = JSON.parse(incompleteLine);
        if (!projectMemoryEventSchema.safeParse(value).success) {
          fail(
            `Error: cannot read project memory ${filePath}: unsupported or invalid event at line ${completeContent.split("\n").length}.`,
          );
        }
      } catch (error) {
        if (error instanceof ProjectMemoryEventFileError) throw error;
      }
    }
  }
  return completeContent
    .split("\n")
    .flatMap((line, index) =>
      line === "" ? [] : [parseEvent(line, filePath, index + 1)],
    );
}

function projectMemoryFileAccessError(
  filePath: string,
  action: "read" | "write" | "repair" | "remove",
  error: unknown,
): never {
  if (
    error instanceof PrivateStateError &&
    error.reason !== "invalid_path" &&
    error.reason !== "io"
  ) {
    unsafeProjectMemoryFile(filePath, error);
  }
  fail(
    `Error: cannot ${action} project memory ${filePath}: ${errorMessage(error)}`,
  );
}

function removeIncompleteFinalEvent(filePath: string): boolean {
  let content: Buffer | null;
  try {
    content = readPrivateFileBuffer({
      path: filePath,
      label: PROJECT_MEMORY_EVENT_FILE_LABEL,
    });
  } catch (error) {
    projectMemoryFileAccessError(filePath, "read", error);
  }
  if (content === null) return false;
  if (content.byteLength === 0 || content.at(-1) === 0x0a) return true;
  const finalNewline = content.lastIndexOf(0x0a);
  try {
    truncatePrivateFile({
      path: filePath,
      label: PROJECT_MEMORY_EVENT_FILE_LABEL,
      size: finalNewline + 1,
    });
  } catch (error) {
    /* v8 ignore next -- repair faults require the file to change after the owner read and before truncate. */
    projectMemoryFileAccessError(filePath, "repair", error);
  }
  return true;
}

export function appendProjectMemoryEvent(
  filePath: string,
  event: ProjectMemoryEvent,
): void {
  projectMemoryEventSchema.parse(event);
  try {
    const content = `${JSON.stringify(event)}\n`;
    const existing = removeIncompleteFinalEvent(filePath);
    if (existing) {
      appendPrivateFile({
        path: filePath,
        label: PROJECT_MEMORY_EVENT_FILE_LABEL,
        content,
      });
      return;
    }
    const result = createPrivateFile({
      path: filePath,
      label: PROJECT_MEMORY_EVENT_FILE_LABEL,
      content,
    });
    /* v8 ignore next 7 -- the project-memory write lock prevents normal concurrent first creation; this preserves race safety. */
    if (result.status === "exists") {
      appendPrivateFile({
        path: filePath,
        label: PROJECT_MEMORY_EVENT_FILE_LABEL,
        content,
      });
    }
  } catch (error) {
    projectMemoryFileAccessError(filePath, "write", error);
  }
}

export function replaceProjectMemoryEvents(
  filePath: string,
  events: readonly ProjectMemoryEvent[],
): void {
  for (const event of events) projectMemoryEventSchema.parse(event);
  try {
    replacePrivateFile({
      path: filePath,
      label: PROJECT_MEMORY_EVENT_FILE_LABEL,
      content:
        events.length === 0
          ? ""
          : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  } catch (error) {
    projectMemoryFileAccessError(filePath, "write", error);
  }
}

export function removeProjectMemoryEventFile(filePath: string): void {
  try {
    removePrivateFile({
      path: filePath,
      label: PROJECT_MEMORY_EVENT_FILE_LABEL,
    });
  } catch (error) {
    projectMemoryFileAccessError(filePath, "remove", error);
  }
}

function acquireDirectoryLease(
  directory: string,
  name: "write.lock" | "candidate-extraction.lock",
  conflictMessage: string,
): () => void {
  const lockPath = join(directory, name);
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (hasNodeErrorCode(error, "EEXIST")) fail(conflictMessage);
    fail(
      `Error: cannot acquire project memory lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
  return () => rmSync(lockPath, { recursive: true, force: true });
}

export function acquireProjectMemoryWriteLock(directory: string): () => void {
  return acquireDirectoryLease(
    directory,
    "write.lock",
    `Error: project memory is locked by another Keel process. If no memory command is running, remove ${join(directory, "write.lock")} and retry.`,
  );
}

export function acquireCandidateExtractionLease(directory: string): () => void {
  return acquireDirectoryLease(
    directory,
    "candidate-extraction.lock",
    "Error: another project-memory candidate extraction is already running for this project.",
  );
}
