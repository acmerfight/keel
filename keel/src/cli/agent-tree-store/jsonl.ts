import {
  appendFileSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { errorMessage } from "../../core/error.ts";

type JsonlKind = "agent tree" | "agent transcript";
export type DirectorySync = (directory: string) => void;

type WriterState =
  | { readonly kind: "writable" }
  | { readonly kind: "failed"; readonly error: Error };

export interface DurableJsonlWriter {
  readonly ensureDirectory: (directory: string) => void;
  readonly syncDirectory: DirectorySync;
  readonly create: (filePath: string, record: object, kind: JsonlKind) => void;
  readonly append: (filePath: string, record: object, kind: JsonlKind) => void;
}

export interface JsonlWriteRuntime {
  readonly create: (filePath: string, content: string) => JsonlCreateResult;
  readonly append: (filePath: string, content: string) => void;
  readonly syncDirectory?: (directory: string) => void;
}

type JsonlCreateResult =
  | { readonly kind: "written" }
  | {
      readonly kind: "failed";
      readonly ownership: "owned" | "unowned";
      readonly error: unknown;
    };

export class IndeterminateJsonlWriteError extends Error {}

export function agentTreeError(message: string): never {
  throw new Error(`Error: ${message}`);
}

function withSyncedFile(
  filePath: string,
  flags: "a" | "r" | "r+" | "wx",
  operation: (fileDescriptor: number) => void,
): void {
  const fileDescriptor = openSync(filePath, flags, 0o600);
  try {
    operation(fileDescriptor);
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
}

function syncDirectoryHandle(directory: string): void {
  withSyncedFile(directory, "r", () => {});
}

export function createPlatformDirectorySync(
  platform: NodeJS.Platform,
  syncDirectory: DirectorySync = syncDirectoryHandle,
): DirectorySync {
  return platform === "win32" ? () => {} : syncDirectory;
}

export const syncDurableDirectory = createPlatformDirectorySync(
  process.platform,
);

function ensureDurableDirectory(
  directory: string,
  syncDirectory: DirectorySync = syncDurableDirectory,
): void {
  const targetDirectory = resolve(directory);
  mkdirSync(targetDirectory, {
    recursive: true,
    mode: 0o700,
  });
  const ancestorDirectories: string[] = [];
  let current = targetDirectory;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    ancestorDirectories.push(parent);
    current = parent;
  }
  for (const ancestor of ancestorDirectories.reverse()) {
    syncDirectory(ancestor);
  }
}

function nodeCreate(filePath: string, content: string): JsonlCreateResult {
  let ownership: "owned" | "unowned" = "unowned";
  try {
    withSyncedFile(filePath, "wx", (fileDescriptor) => {
      ownership = "owned";
      writeFileSync(fileDescriptor, content, "utf8");
    });
    return { kind: "written" };
  } catch (error) {
    return { kind: "failed", ownership, error };
  }
}

function nodeAppend(filePath: string, content: string): void {
  withSyncedFile(filePath, "a", (fileDescriptor) => {
    appendFileSync(fileDescriptor, content, "utf8");
  });
}

const nodeJsonlWriteRuntime: JsonlWriteRuntime = {
  create: nodeCreate,
  append: nodeAppend,
};

function rollbackAppend(filePath: string, originalBytes: number): void {
  withSyncedFile(filePath, "r+", (fileDescriptor) => {
    ftruncateSync(fileDescriptor, originalBytes);
  });
}

export function createDurableJsonlWriter(
  runtime: JsonlWriteRuntime = nodeJsonlWriteRuntime,
): DurableJsonlWriter {
  let state: WriterState = { kind: "writable" };
  const ensuredDirectories = new Set<string>();
  const syncDirectory = runtime.syncDirectory ?? syncDurableDirectory;

  const writable = (): void => {
    if (state.kind === "failed") throw state.error;
  };
  const fail = (message: string, caught: unknown): never => {
    const failure = new Error(`Error: ${message}: ${errorMessage(caught)}`);
    state = { kind: "failed", error: failure };
    throw failure;
  };
  const ensureDirectory = (directory: string): void => {
    writable();
    const targetDirectory = resolve(directory);
    if (ensuredDirectories.has(targetDirectory)) return;
    try {
      ensureDurableDirectory(targetDirectory, syncDirectory);
    } catch (caught) {
      const failure = new IndeterminateJsonlWriteError(
        `Error: cannot establish durable directory ${targetDirectory}: ${errorMessage(caught)}`,
      );
      state = { kind: "failed", error: failure };
      throw failure;
    }
    let current = targetDirectory;
    for (;;) {
      ensuredDirectories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };

  return {
    ensureDirectory,
    syncDirectory,
    create: (filePath, record, kind) => {
      writable();
      ensureDirectory(dirname(filePath));
      const result = runtime.create(filePath, `${JSON.stringify(record)}\n`);
      if (result.kind === "written") {
        try {
          syncDirectory(dirname(filePath));
        } catch (caught) {
          const failure = new IndeterminateJsonlWriteError(
            `Error: cannot publish ${kind} ${filePath}: ${errorMessage(caught)}`,
          );
          state = { kind: "failed", error: failure };
          throw failure;
        }
        return;
      }
      if (result.ownership === "owned") {
        try {
          rmSync(filePath);
          syncDirectory(dirname(filePath));
        } catch (cleanupFailure) {
          const failure = new IndeterminateJsonlWriteError(
            `Error: cannot create ${kind} ${filePath}: ${errorMessage(result.error)}; cleanup failed: ${errorMessage(cleanupFailure)}`,
          );
          state = { kind: "failed", error: failure };
          throw failure;
        }
      }
      fail(`cannot create ${kind} ${filePath}`, result.error);
    },
    append: (filePath, record, kind) => {
      writable();
      const originalBytes = ((): number => {
        try {
          return statSync(filePath).size;
        } catch (caught) {
          return fail(
            `cannot inspect ${kind} ${filePath} before writing`,
            caught,
          );
        }
      })();
      try {
        runtime.append(filePath, `${JSON.stringify(record)}\n`);
      } catch (caught) {
        try {
          rollbackAppend(filePath, originalBytes);
        } catch (rollbackFailure) {
          const failure = new IndeterminateJsonlWriteError(
            `Error: cannot write ${kind} ${filePath}: ${errorMessage(caught)}; rollback failed: ${errorMessage(rollbackFailure)}`,
          );
          state = { kind: "failed", error: failure };
          throw failure;
        }
        fail(`cannot write ${kind} ${filePath}`, caught);
      }
    },
  };
}

function readBoundedBuffer(filePath: string, maxBytes: number): Buffer {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (caught) {
    agentTreeError(`cannot read ${filePath}: ${errorMessage(caught)}`);
  }
  if (size > maxBytes) {
    agentTreeError(
      `${filePath} is too large (${size} bytes; limit ${maxBytes} bytes)`,
    );
  }
  try {
    return readFileSync(filePath);
  } catch (caught) {
    agentTreeError(`cannot read ${filePath}: ${errorMessage(caught)}`);
  }
}

function decodeUtf8(filePath: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (caught) {
    agentTreeError(
      `cannot decode ${filePath} as UTF-8: ${errorMessage(caught)}`,
    );
  }
}

function appendFinalNewline(filePath: string): void {
  try {
    withSyncedFile(filePath, "a", (fileDescriptor) => {
      appendFileSync(fileDescriptor, "\n", "utf8");
    });
  } catch (caught) {
    agentTreeError(
      `cannot complete JSONL tail ${filePath}: ${errorMessage(caught)}`,
    );
  }
}

function truncateTail(filePath: string, byteLength: number): void {
  try {
    withSyncedFile(filePath, "r+", (fileDescriptor) => {
      ftruncateSync(fileDescriptor, byteLength);
    });
  } catch (caught) {
    agentTreeError(
      `cannot repair incomplete JSONL tail ${filePath}: ${errorMessage(caught)}`,
    );
  }
}

export function readRepairableJsonl(
  filePath: string,
  maxBytes: number,
): string {
  const bytes = readBoundedBuffer(filePath, maxBytes);
  if (bytes.at(-1) === 0x0a) return decodeUtf8(filePath, bytes);

  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    agentTreeError(`cannot recover incomplete JSONL header ${filePath}`);
  }
  const prefix = bytes.subarray(0, lastNewline + 1);
  const trailingBytes = bytes.subarray(lastNewline + 1);
  let trailingRecord: string | undefined;
  try {
    trailingRecord = new TextDecoder("utf-8", { fatal: true }).decode(
      trailingBytes,
    );
    JSON.parse(trailingRecord);
  } catch {
    truncateTail(filePath, lastNewline + 1);
    return decodeUtf8(filePath, prefix);
  }
  appendFinalNewline(filePath);
  return `${decodeUtf8(filePath, prefix)}${trailingRecord}\n`;
}

export function parseJsonLine(
  filePath: string,
  line: string,
  lineNumber: number,
): unknown {
  try {
    return JSON.parse(line);
  } catch (caught) {
    agentTreeError(
      `cannot parse ${filePath} line ${lineNumber}: ${errorMessage(caught)}`,
    );
  }
}
