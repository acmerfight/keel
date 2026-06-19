import { closeSync, openSync, readSync, statSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import {
  BINARY_SAMPLE_BYTES,
  binaryFileError,
  decodeUtf8,
  hasBinaryControlBytes,
  isBinarySample,
} from "./text-file.ts";
import type { ToolResult } from "./types.ts";
import { resolveWorkspaceTarget } from "./workspace-path.ts";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;

const READ_CHUNK_BYTES = 8192;

export interface ReadOptions {
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

interface NormalizedReadOptions {
  readonly offset: number;
  readonly limit: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function normalizeReadOptions(
  filePath: string,
  options: ReadOptions,
): NormalizedReadOptions {
  const offset = options.offset ?? 1;
  const requestedLimit = options.limit ?? MAX_READ_LINES;

  if (!Number.isInteger(offset) || offset < 1) {
    throw new KeelError(
      "tool_invalid_read_options",
      `read failed: offset must be a positive integer in ${filePath}`,
    );
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new KeelError(
      "tool_invalid_read_options",
      `read failed: limit must be a positive integer in ${filePath}`,
    );
  }

  return {
    offset,
    limit: Math.min(requestedLimit, MAX_READ_LINES),
  };
}

function readSample(fd: number, fileSize: number): Uint8Array {
  const sampleLength = Math.min(BINARY_SAMPLE_BYTES, fileSize);
  if (sampleLength === 0) return new Uint8Array();

  const sample = Buffer.alloc(sampleLength);
  const bytesRead = readSync(fd, sample, 0, sampleLength, 0);
  return sample.subarray(0, bytesRead);
}

function appendTruncationNotice(
  content: string,
  options: NormalizedReadOptions,
  outputLines: number,
  reason: "budget" | "line-limit",
): string {
  const nextOffset = options.offset + outputLines;
  const limit =
    options.limit === MAX_READ_LINES
      ? `${MAX_READ_LINES} lines`
      : `requested limit of ${options.limit} lines`;
  const notice =
    reason === "budget"
      ? `[Read output truncated at ${MAX_READ_LINES} lines or ${formatSize(
          MAX_READ_BYTES,
        )}. Use offset=${nextOffset} to continue.]`
      : `[Read output stopped at ${limit}. Use offset=${nextOffset} to continue.]`;
  if (content === "") return notice;
  if (content.endsWith("\n")) return `${content}\n${notice}`;
  return `${content}\n\n${notice}`;
}

type TruncationReason = "budget" | "line-limit";

type LineWindowAccumulator = {
  lineBuffer: string;
  lineBytes: number;
  lineNumber: number;
  countedLines: number;
  content: string;
  outputBytes: number;
  outputLines: number;
  truncated: boolean;
  truncatedReason: TruncationReason;
  firstLineExceedsLimit: boolean;
  keepReading: boolean;
  hasCurrentLineContent: boolean;
};

function createLineWindowAccumulator(): LineWindowAccumulator {
  return {
    lineBuffer: "",
    lineBytes: 0,
    lineNumber: 1,
    countedLines: 0,
    content: "",
    outputBytes: 0,
    outputLines: 0,
    truncated: false,
    truncatedReason: "budget",
    firstLineExceedsLimit: false,
    keepReading: true,
    hasCurrentLineContent: false,
  };
}

function finishAccumulatorLine(acc: LineWindowAccumulator): void {
  acc.countedLines = acc.lineNumber;
  acc.lineNumber++;
  acc.hasCurrentLineContent = false;
}

function flushAccumulatorOutputLine(acc: LineWindowAccumulator): void {
  acc.content += acc.lineBuffer;
  acc.outputBytes += acc.lineBytes;
  acc.outputLines++;
  acc.lineBuffer = "";
  acc.lineBytes = 0;
  finishAccumulatorLine(acc);
}

function consumeLinePiece(
  acc: LineWindowAccumulator,
  options: NormalizedReadOptions,
  piece: string,
  completesLine: boolean,
): void {
  if (piece !== "") {
    acc.hasCurrentLineContent = true;
  }

  if (acc.lineNumber < options.offset) {
    if (completesLine) {
      finishAccumulatorLine(acc);
    }
    return;
  }

  if (acc.outputLines >= options.limit) {
    acc.truncated = true;
    acc.truncatedReason = "line-limit";
    acc.keepReading = false;
    return;
  }

  const pieceBytes = Buffer.byteLength(piece, "utf8");
  const projectedLineBytes = acc.lineBytes + pieceBytes;
  if (acc.outputBytes + projectedLineBytes > MAX_READ_BYTES) {
    acc.truncated = true;
    acc.truncatedReason = "budget";
    acc.firstLineExceedsLimit = acc.outputLines === 0;
    acc.keepReading = false;
    return;
  }

  acc.lineBuffer += piece;
  acc.lineBytes = projectedLineBytes;

  if (completesLine) {
    flushAccumulatorOutputLine(acc);
  }
}

function consumeDecodedText(
  acc: LineWindowAccumulator,
  options: NormalizedReadOptions,
  text: string,
): void {
  let cursor = 0;
  while (acc.keepReading) {
    const newlineIndex = text.indexOf("\n", cursor);
    if (newlineIndex < 0) {
      const piece = text.slice(cursor);
      if (piece !== "") {
        consumeLinePiece(acc, options, piece, false);
      }
      break;
    }

    consumeLinePiece(acc, options, text.slice(cursor, newlineIndex + 1), true);
    cursor = newlineIndex + 1;
  }
}

function readTextWindow(
  fd: number,
  filePath: string,
  options: NormalizedReadOptions,
): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const acc = createLineWindowAccumulator();

  while (acc.keepReading) {
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;

    const bytes = chunk.subarray(0, bytesRead);
    if (hasBinaryControlBytes(bytes)) {
      throw binaryFileError("read", filePath);
    }

    consumeDecodedText(
      acc,
      options,
      decodeUtf8("read", filePath, decoder, bytes, { stream: true }),
    );
  }

  if (acc.keepReading) {
    const remaining = decodeUtf8("read", filePath, decoder);
    if (remaining !== "") {
      consumeDecodedText(acc, options, remaining);
    }
    if (acc.keepReading && acc.hasCurrentLineContent) {
      if (acc.lineNumber < options.offset) {
        finishAccumulatorLine(acc);
      } else {
        flushAccumulatorOutputLine(acc);
      }
    }
  }

  if (
    acc.countedLines < options.offset &&
    options.offset !== 1 &&
    acc.outputLines === 0
  ) {
    throw new KeelError(
      "tool_read_offset_out_of_range",
      `read failed: offset ${options.offset} is beyond end of file (${acc.countedLines} lines)`,
      `Retry read with a smaller offset, or omit offset to read from the start. Available lines: ${acc.countedLines}.`,
    );
  }

  if (acc.firstLineExceedsLimit) {
    return `[Read output truncated: line ${options.offset} exceeds ${formatSize(
      MAX_READ_BYTES,
    )}. Use grep to find a smaller target before reading this file.]`;
  }

  return acc.truncated
    ? appendTruncationNotice(
        acc.content,
        options,
        acc.outputLines,
        acc.truncatedReason,
      )
    : acc.content;
}

export function executeRead(
  workspace: string,
  filePath: string,
  options: ReadOptions = {},
): ToolResult {
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    filePath,
    "read",
  );

  const stat = statSync(targetPath);
  const targetIsDirectory = stat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(targetPath, targetIsDirectory)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `read failed: ignored path: ${filePath}`,
      "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
    );
  }
  if (!stat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `read failed: not a file: ${filePath}`,
      "The path is a directory, not a file. Use grep to search within it, or specify a file path inside it.",
    );
  }

  const normalizedOptions = normalizeReadOptions(filePath, options);
  const fd = openSync(targetPath, "r");
  try {
    const sample = readSample(fd, stat.size);
    if (isBinarySample(targetPath, sample)) {
      throw binaryFileError("read", filePath);
    }

    return { content: readTextWindow(fd, filePath, normalizedOptions) };
  } finally {
    closeSync(fd);
  }
}
