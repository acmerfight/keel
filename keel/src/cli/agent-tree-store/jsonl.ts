import { closeSync, constants, fsyncSync, openSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { errorMessage } from "../../core/error.ts";
import {
  appendPrivateFile,
  createPrivateFile,
  ensurePrivateDirectory,
  privateFileSize,
  readPrivateFileBuffer,
  truncatePrivateFile,
} from "../../core/private-state.ts";

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

function syncDirectoryHandle(directory: string): void {
  const fileDescriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
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
  ensurePrivateDirectory(targetDirectory, "durable JSONL directory");
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
    const result = createPrivateFile({
      path: filePath,
      label: "agent tree JSONL",
      content,
    });
    if (result.status === "exists") {
      throw new Error("file already exists");
    }
    ownership = "owned";
    return { kind: "written" };
  } catch (error) {
    return { kind: "failed", ownership, error };
  }
}

function nodeAppend(filePath: string, content: string): void {
  appendPrivateFile({
    path: filePath,
    label: "agent tree JSONL",
    content,
  });
}

const nodeJsonlWriteRuntime: JsonlWriteRuntime = {
  create: nodeCreate,
  append: nodeAppend,
};

function rollbackAppend(filePath: string, originalBytes: number): void {
  truncatePrivateFile({
    path: filePath,
    label: "agent tree JSONL",
    size: originalBytes,
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
          const size = privateFileSize({
            path: filePath,
            label: kind,
          });
          if (size === null) throw new Error("file not found");
          return size;
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
    const measuredSize = privateFileSize({
      path: filePath,
      label: "agent tree JSONL",
    });
    if (measuredSize === null) {
      agentTreeError(`cannot read ${filePath}: file not found`);
    }
    size = measuredSize;
  } catch (caught) {
    agentTreeError(`cannot read ${filePath}: ${errorMessage(caught)}`);
  }
  if (size > maxBytes) {
    agentTreeError(
      `${filePath} is too large (${size} bytes; limit ${maxBytes} bytes)`,
    );
  }
  try {
    const content = readPrivateFileBuffer({
      path: filePath,
      label: "agent tree JSONL",
    });
    /* v8 ignore next -- the file can disappear between size inspection and read. */
    if (content === null) {
      agentTreeError(`cannot read ${filePath}: file not found`);
    }
    return content;
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
    appendPrivateFile({
      path: filePath,
      label: "agent tree JSONL",
      content: "\n",
    });
  } catch (caught) {
    agentTreeError(
      `cannot complete JSONL tail ${filePath}: ${errorMessage(caught)}`,
    );
  }
}

function truncateTail(filePath: string, byteLength: number): void {
  try {
    truncatePrivateFile({
      path: filePath,
      label: "agent tree JSONL",
      size: byteLength,
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
