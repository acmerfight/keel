import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";
import { errorMessage } from "../../core/error.ts";
import {
  formatNestedSessionStoreError,
  hasNodeErrorCode,
  SessionStoreError,
  sessionStoreError,
} from "./errors.ts";
import {
  SESSION_LEDGER_HEADER_READ_MAX_BYTES,
  SESSION_LEDGER_RESUME_MAX_BYTES,
  type SessionHeaderRecord,
  type SessionMutationRecord,
  type SessionRecords,
  type SnapshotSearchResult,
} from "./model.ts";
import {
  parseSessionHeaderRecord,
  parseSessionMutationRecord,
  parseSnapshotSessionMutationRecord,
  serializeSessionGoalForPersistence,
} from "./records.ts";

function serializeSessionMutationRecord(
  record: SessionMutationRecord,
): unknown {
  if (record.type === "session_goal") {
    return {
      ...record,
      goal:
        record.goal === null
          ? null
          : serializeSessionGoalForPersistence(record.goal),
    };
  }
  if (record.type === "snapshot" && record.goal !== undefined) {
    return {
      ...record,
      goal: serializeSessionGoalForPersistence(record.goal),
    };
  }
  return record;
}

function appendJsonLine(filePath: string, record: SessionMutationRecord): void {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    fd = openSync(filePath, "a", 0o600);
    appendFileSync(
      fd,
      `${JSON.stringify(serializeSessionMutationRecord(record))}\n`,
      "utf8",
    );
    fsyncSync(fd);
  } catch (error) {
    sessionStoreError(
      `Error: cannot write session ledger ${filePath}: ${errorMessage(error)}`,
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function serializeSessionHeaderLine(
  filePath: string,
  header: SessionHeaderRecord,
): string {
  const line = `${JSON.stringify(header)}\n`;
  const byteLength = Buffer.byteLength(line, "utf8");
  if (byteLength > SESSION_LEDGER_HEADER_READ_MAX_BYTES) {
    sessionStoreError(
      `Error: cannot create session ledger ${filePath}: session header is too large (${formatByteCount(byteLength)}; limit ${formatByteCount(SESSION_LEDGER_HEADER_READ_MAX_BYTES)}).`,
    );
  }
  return line;
}

function writeInitialHeader(
  filePath: string,
  header: SessionHeaderRecord,
  mutations: readonly SessionMutationRecord[] = [],
): void {
  const headerLine = serializeSessionHeaderLine(filePath, header);
  const content = `${headerLine}${mutations
    .map(
      (record) => `${JSON.stringify(serializeSessionMutationRecord(record))}\n`,
    )
    .join("")}`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (hasNodeErrorCode(error, "EEXIST")) {
      sessionStoreError(
        `Error: session "${header.id}" already exists. Use --resume ${header.id} to continue it.`,
      );
    }
    sessionStoreError(
      `Error: cannot create session ledger ${filePath}: ${errorMessage(error)}`,
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function formatByteCount(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function sessionLedgerSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      sessionStoreError(`Error: session ledger not found at ${filePath}.`);
    }
    sessionStoreError(
      `Error: cannot inspect session ledger ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function sessionLedgerReadError(filePath: string, error: unknown): never {
  /* v8 ignore next 3: stat succeeds before reads; ENOENT here requires a filesystem race. */
  if (hasNodeErrorCode(error, "ENOENT")) {
    sessionStoreError(`Error: session ledger not found at ${filePath}.`);
  }
  sessionStoreError(
    `Error: cannot read session ledger ${filePath}: ${errorMessage(error)}`,
  );
}

function oversizedSessionLedgerError(
  filePath: string,
  ledgerSize: number,
): never {
  sessionStoreError(
    `Error: cannot load session ledger ${filePath}: ledger is too large to resume safely (${formatByteCount(ledgerSize)}; limit ${formatByteCount(SESSION_LEDGER_RESUME_MAX_BYTES)}), and no bounded snapshot was found in the final ${formatByteCount(SESSION_LEDGER_RESUME_MAX_BYTES)}. Start a new session with --session <new-id>, or inspect and archive this ledger manually if you need its old context.`,
  );
}

function readSessionLedgerBufferRange(
  filePath: string,
  start: number,
  length: number,
): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(
        fd,
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      /* v8 ignore next 3 -- reaching EOF after stat requires an external truncation race. */
      if (bytesRead === 0) {
        throw new Error("unexpected end of file");
      }
      offset += bytesRead;
    }
    return buffer;
  } catch (error) {
    return sessionLedgerReadError(filePath, error);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function readSessionLedgerRange(
  filePath: string,
  start: number,
  length: number,
): string {
  return readSessionLedgerBufferRange(filePath, start, length).toString("utf8");
}

function splitSessionJsonLines(content: string): readonly string[] {
  return content.split("\n").filter((line) => line !== "");
}

function readSessionHeaderLine(filePath: string, ledgerSize: number): string {
  const sample = readSessionLedgerRange(
    filePath,
    0,
    Math.min(ledgerSize, SESSION_LEDGER_HEADER_READ_MAX_BYTES),
  );
  const [headerLine = ""] = sample.split("\n", 1);
  if (headerLine === "") {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: ledger has no session header.`,
    );
  }
  return headerLine;
}

function readCompleteTailSessionJsonLines(
  filePath: string,
  ledgerSize: number,
): readonly string[] {
  const tailStart = ledgerSize - SESSION_LEDGER_RESUME_MAX_BYTES;
  const readStart = tailStart - 1;
  const tail = readSessionLedgerRange(
    filePath,
    readStart,
    ledgerSize - readStart,
  );
  if (tail.startsWith("\n")) {
    return splitSessionJsonLines(tail.slice(1));
  }

  const firstNewlineIndex = tail.indexOf("\n");
  if (firstNewlineIndex === -1) {
    return [];
  }
  return splitSessionJsonLines(tail.slice(firstNewlineIndex + 1));
}

function findLatestSnapshotRecord(
  tailLines: readonly string[],
): SnapshotSearchResult | null {
  for (const [index, line] of [...tailLines.entries()].reverse()) {
    const record = parseSnapshotSessionMutationRecord(line);
    if (record !== null) {
      return { index, record };
    }
  }
  return null;
}

function parseSessionRecordsFromLines(
  filePath: string,
  lines: readonly string[],
): SessionRecords {
  const [headerLine, ...mutationLines] = lines;
  if (headerLine === undefined) {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: ledger has no session header.`,
    );
  }

  return {
    header: parseSessionHeaderRecord(filePath, headerLine, 1),
    mutations: mutationLines.map((line, index) =>
      parseSessionMutationRecord(filePath, line, index + 2),
    ),
  };
}

function readOversizedSessionRecords(
  filePath: string,
  ledgerSize: number,
): SessionRecords {
  const header = parseSessionHeaderRecord(
    filePath,
    readSessionHeaderLine(filePath, ledgerSize),
    1,
  );
  const tailLines = readCompleteTailSessionJsonLines(filePath, ledgerSize);
  const snapshot = findLatestSnapshotRecord(tailLines);
  if (snapshot === null) {
    oversizedSessionLedgerError(filePath, ledgerSize);
  }

  return {
    header,
    mutations: [
      snapshot.record,
      ...tailLines
        .slice(snapshot.index + 1)
        .map((line, index) =>
          parseSessionMutationRecord(
            filePath,
            line,
            snapshot.index + index + 2,
          ),
        ),
    ],
  };
}

function readSessionRecords(filePath: string): SessionRecords {
  return readSessionRecordsAtSize(filePath, sessionLedgerSize(filePath));
}

function readSessionRecordsAtSize(
  filePath: string,
  ledgerSize: number,
): SessionRecords {
  if (ledgerSize > SESSION_LEDGER_RESUME_MAX_BYTES) {
    return readOversizedSessionRecords(filePath, ledgerSize);
  }

  return parseSessionRecordsFromLines(
    filePath,
    splitSessionJsonLines(readSessionLedgerRange(filePath, 0, ledgerSize)),
  );
}

type SessionLedgerTail =
  | { readonly kind: "complete" }
  | { readonly kind: "valid_unterminated_record" }
  | {
      readonly kind: "invalid_unterminated_fragment";
      readonly retainedBytes: number;
      readonly droppedBytes: number;
    };

function inspectSessionLedgerTail(filePath: string): SessionLedgerTail {
  const ledgerSize = sessionLedgerSize(filePath);
  if (ledgerSize === 0) {
    return { kind: "complete" };
  }
  const sampleLength = Math.min(
    ledgerSize,
    SESSION_LEDGER_RESUME_MAX_BYTES + 1,
  );
  const sampleStart = ledgerSize - sampleLength;
  const sample = readSessionLedgerBufferRange(
    filePath,
    sampleStart,
    sampleLength,
  );
  if (sample.at(-1) === 0x0a) {
    return { kind: "complete" };
  }
  const finalNewlineIndex = sample.lastIndexOf(0x0a);
  if (finalNewlineIndex === -1) {
    if (sampleStart === 0) {
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
          sample,
        );
        JSON.parse(decoded);
        return { kind: "valid_unterminated_record" };
      } catch {
        sessionStoreError(
          `Error: cannot repair session ledger ${filePath}: the unterminated content includes an invalid or incomplete session header.`,
        );
      }
    }
    sessionStoreError(
      `Error: cannot repair session ledger ${filePath}: the unterminated final JSONL record exceeds ${formatByteCount(SESSION_LEDGER_RESUME_MAX_BYTES)}.`,
    );
  }
  const fragment = sample.subarray(finalNewlineIndex + 1);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(fragment);
    JSON.parse(decoded);
    return { kind: "valid_unterminated_record" };
  } catch {
    return {
      kind: "invalid_unterminated_fragment",
      retainedBytes: sampleStart + finalNewlineIndex + 1,
      droppedBytes: fragment.byteLength,
    };
  }
}

function formatResumeSessionLoadError(error: unknown): string {
  /* v8 ignore next 3: readSessionRecords converts disk and parser failures to SessionStoreError. */
  if (!(error instanceof SessionStoreError)) {
    throw error;
  }
  return formatNestedSessionStoreError(error);
}

export {
  appendJsonLine,
  formatResumeSessionLoadError,
  inspectSessionLedgerTail,
  readSessionHeaderLine,
  readSessionRecords,
  readSessionRecordsAtSize,
  sessionLedgerSize,
  writeInitialHeader,
};
