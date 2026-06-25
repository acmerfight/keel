import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
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
} from "./records.ts";

function appendJsonLine(filePath: string, record: SessionMutationRecord): void {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    fd = openSync(filePath, "a", 0o600);
    appendFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
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

function writeInitialHeader(
  filePath: string,
  header: SessionHeaderRecord,
): void {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(header)}\n`, "utf8");
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

function readSessionLedgerContent(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    return sessionLedgerReadError(filePath, error);
  }
}

function readSessionLedgerRange(
  filePath: string,
  start: number,
  length: number,
): string {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    return sessionLedgerReadError(filePath, error);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
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
  const newlineIndex = sample.indexOf("\n");
  const headerLine =
    newlineIndex === -1 ? sample : sample.slice(0, newlineIndex);
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
  const tailStart = Math.max(0, ledgerSize - SESSION_LEDGER_RESUME_MAX_BYTES);
  const readStart = tailStart === 0 ? 0 : tailStart - 1;
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
  const ledgerSize = sessionLedgerSize(filePath);
  if (ledgerSize > SESSION_LEDGER_RESUME_MAX_BYTES) {
    return readOversizedSessionRecords(filePath, ledgerSize);
  }

  return parseSessionRecordsFromLines(
    filePath,
    splitSessionJsonLines(readSessionLedgerContent(filePath)),
  );
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
  readSessionHeaderLine,
  readSessionRecords,
  sessionLedgerSize,
  writeInitialHeader,
};
