import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../core/error.ts";
import {
  type ProjectMemoryEvent,
  projectMemoryEventSchema,
} from "./project-memory-events.ts";

export class ProjectMemoryEventFileError extends Error {}

function fail(message: string): never {
  throw new ProjectMemoryEventFileError(message);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Reflect.get(Object(error), "code") === code;
}

function fileKind(path: string): "missing" | "file" | "unsafe" {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return "missing";
  if (stat.isFile()) return "file";
  return "unsafe";
}

function writeAll(fd: number, content: string): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.byteLength) {
    offset += writeSync(fd, buffer, offset, buffer.byteLength - offset);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
  const kind = fileKind(filePath);
  if (kind === "missing") return [];
  if (kind === "unsafe") {
    fail(
      `Error: unsafe project memory path ${filePath}: expected a regular file.`,
    );
  }
  chmodSync(filePath, 0o600);
  const content = readFileSync(filePath, "utf8");
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

function removeIncompleteFinalEvent(filePath: string): void {
  if (fileKind(filePath) === "missing") return;
  const content = readFileSync(filePath);
  if (content.byteLength === 0 || content.at(-1) === 0x0a) return;
  const finalNewline = content.lastIndexOf(0x0a);
  truncateSync(filePath, finalNewline + 1);
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendProjectMemoryEvent(
  filePath: string,
  event: ProjectMemoryEvent,
): void {
  projectMemoryEventSchema.parse(event);
  const existingKind = fileKind(filePath);
  if (existingKind === "unsafe") {
    fail(
      `Error: unsafe project memory path ${filePath}: expected a regular file.`,
    );
  }
  removeIncompleteFinalEvent(filePath);
  const fd = openSync(
    filePath,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeAll(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
    chmodSync(filePath, 0o600);
    if (existingKind === "missing") fsyncDirectory(dirname(filePath));
  } finally {
    closeSync(fd);
  }
}

function openPrivateNewFile(path: string): number {
  return openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
}

export function replaceProjectMemoryEvents(
  filePath: string,
  events: readonly ProjectMemoryEvent[],
): void {
  for (const event of events) projectMemoryEventSchema.parse(event);
  const directory = dirname(filePath);
  const replacementPath = join(directory, `.events-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openPrivateNewFile(replacementPath);
    writeAll(
      fd,
      events.length === 0
        ? ""
        : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    fsyncSync(fd);
    chmodSync(replacementPath, 0o600);
    closeSync(fd);
    fd = undefined;
    renameSync(replacementPath, filePath);
    fsyncDirectory(directory);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      rmSync(replacementPath, { force: true });
    }
  }
}

export function removeProjectMemoryEventFile(filePath: string): void {
  const kind = fileKind(filePath);
  if (kind === "missing") return;
  if (kind === "unsafe") {
    fail(
      `Error: unsafe project memory path ${filePath}: expected a regular file.`,
    );
  }
  rmSync(filePath);
  fsyncDirectory(dirname(filePath));
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
