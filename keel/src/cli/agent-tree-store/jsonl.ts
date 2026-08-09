import {
  appendFileSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";
import { errorMessage } from "../../core/error.ts";

type JsonlKind = "agent tree" | "agent transcript";

type WriterState =
  | { readonly kind: "writable" }
  | { readonly kind: "failed"; readonly error: Error };

export interface DurableJsonlWriter {
  readonly create: (filePath: string, record: object, kind: JsonlKind) => void;
  readonly append: (filePath: string, record: object, kind: JsonlKind) => void;
}

export interface JsonlWriteRuntime {
  readonly create: (filePath: string, content: string) => void;
  readonly append: (filePath: string, content: string) => void;
}

export class IndeterminateJsonlWriteError extends Error {}

export function agentTreeError(message: string): never {
  throw new Error(`Error: ${message}`);
}

function closeAfterWrite(
  fileDescriptor: number | undefined,
  failure: unknown,
): unknown {
  if (fileDescriptor === undefined) return failure;
  try {
    closeSync(fileDescriptor);
    return failure;
  } catch (caught) {
    return failure ?? caught;
  }
}

function nodeCreate(filePath: string, content: string): void {
  let fileDescriptor: number | undefined;
  let failure: unknown;
  try {
    fileDescriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(fileDescriptor, content, "utf8");
    fsyncSync(fileDescriptor);
  } catch (caught) {
    failure = caught;
  }
  failure = closeAfterWrite(fileDescriptor, failure);
  if (failure !== undefined) throw failure;
}

function nodeAppend(filePath: string, content: string): void {
  let fileDescriptor: number | undefined;
  let failure: unknown;
  try {
    fileDescriptor = openSync(filePath, "a", 0o600);
    appendFileSync(fileDescriptor, content, "utf8");
    fsyncSync(fileDescriptor);
  } catch (caught) {
    failure = caught;
  }
  failure = closeAfterWrite(fileDescriptor, failure);
  if (failure !== undefined) throw failure;
}

const nodeJsonlWriteRuntime: JsonlWriteRuntime = {
  create: nodeCreate,
  append: nodeAppend,
};

function rollbackAppend(filePath: string, originalBytes: number): void {
  let fileDescriptor: number | undefined;
  let failure: unknown;
  try {
    fileDescriptor = openSync(filePath, "r+");
    ftruncateSync(fileDescriptor, originalBytes);
    fsyncSync(fileDescriptor);
  } catch (caught) {
    failure = caught;
  }
  failure = closeAfterWrite(fileDescriptor, failure);
  if (failure !== undefined) throw failure;
}

export function createDurableJsonlWriter(
  runtime: JsonlWriteRuntime = nodeJsonlWriteRuntime,
): DurableJsonlWriter {
  let state: WriterState = { kind: "writable" };

  const writable = (): void => {
    if (state.kind === "failed") throw state.error;
  };
  const fail = (message: string, caught: unknown): never => {
    const failure = new Error(`Error: ${message}: ${errorMessage(caught)}`);
    state = { kind: "failed", error: failure };
    throw failure;
  };

  return {
    create: (filePath, record, kind) => {
      writable();
      try {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
        runtime.create(filePath, `${JSON.stringify(record)}\n`);
      } catch (caught) {
        try {
          unlinkSync(filePath);
        } catch {
          // Reopening fails closed if an incomplete new ledger cannot be removed.
        }
        fail(`cannot create ${kind} ${filePath}`, caught);
      }
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
  let fileDescriptor: number | undefined;
  let failure: unknown;
  try {
    fileDescriptor = openSync(filePath, "a", 0o600);
    appendFileSync(fileDescriptor, "\n", "utf8");
    fsyncSync(fileDescriptor);
  } catch (caught) {
    failure = caught;
  }
  failure = closeAfterWrite(fileDescriptor, failure);
  if (failure !== undefined) {
    agentTreeError(
      `cannot complete JSONL tail ${filePath}: ${errorMessage(failure)}`,
    );
  }
}

function truncateTail(filePath: string, byteLength: number): void {
  let fileDescriptor: number | undefined;
  let failure: unknown;
  try {
    fileDescriptor = openSync(filePath, "r+");
    ftruncateSync(fileDescriptor, byteLength);
    fsyncSync(fileDescriptor);
  } catch (caught) {
    failure = caught;
  }
  failure = closeAfterWrite(fileDescriptor, failure);
  if (failure !== undefined) {
    agentTreeError(
      `cannot repair incomplete JSONL tail ${filePath}: ${errorMessage(failure)}`,
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
