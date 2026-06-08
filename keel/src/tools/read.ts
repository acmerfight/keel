import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { KeelError } from "../core/error.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";

export const MAX_READ_LINES = 2000;
export const MAX_READ_BYTES = 50 * 1024;

const BINARY_SAMPLE_BYTES = 4096;
const READ_CHUNK_BYTES = 8192;
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".aac",
  ".apk",
  ".avif",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".dat",
  ".db",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".ico",
  ".iso",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lib",
  ".m4a",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".o",
  ".obj",
  ".odt",
  ".ods",
  ".odp",
  ".ogg",
  ".ogv",
  ".otf",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".pyc",
  ".pyo",
  ".rar",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tgz",
  ".tif",
  ".tiff",
  ".ttf",
  ".war",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
  ".zst",
]);

export interface ReadOptions {
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

interface NormalizedReadOptions {
  readonly offset: number;
  readonly limit: number;
}

function isInsideWorkspace(workspace: string, target: string): boolean {
  const targetFromWorkspace = relative(workspace, target);
  return (
    targetFromWorkspace === "" ||
    (!targetFromWorkspace.startsWith("..") && !isAbsolute(targetFromWorkspace))
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function binaryFileError(filePath: string): KeelError {
  return new KeelError(
    "tool_binary_file",
    `read failed: binary file is not supported: ${filePath}`,
  );
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

function startsWithBytes(
  bytes: Uint8Array,
  expected: readonly number[],
): boolean {
  if (bytes.length < expected.length) return false;
  return expected.every((byte, index) => bytes[index] === byte);
}

function hasMagicBinaryHeader(bytes: Uint8Array): boolean {
  return (
    startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) ||
    startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    startsWithBytes(bytes, [0x42, 0x4d]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(bytes, [0x1f, 0x8b]) ||
    startsWithBytes(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    startsWithBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) ||
    startsWithBytes(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    (bytes.length >= 12 &&
      startsWithBytes(bytes.subarray(0, 4), [0x52, 0x49, 0x46, 0x46]) &&
      startsWithBytes(bytes.subarray(8, 12), [0x57, 0x45, 0x42, 0x50])) ||
    (bytes.length >= 12 &&
      startsWithBytes(bytes.subarray(4, 8), [0x66, 0x74, 0x79, 0x70]))
  );
}

function hasBinaryControlBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) {
      nonPrintable++;
    }
  }

  return nonPrintable / bytes.length > 0.3;
}

function isBinarySample(filePath: string, sample: Uint8Array): boolean {
  return (
    BINARY_EXTENSIONS.has(extname(filePath).toLowerCase()) ||
    hasMagicBinaryHeader(sample) ||
    hasBinaryControlBytes(sample)
  );
}

function decodeUtf8(
  filePath: string,
  decoder: TextDecoder,
  input?: Uint8Array,
  options?: TextDecodeOptions,
): string {
  try {
    return decoder.decode(input, options);
  } catch {
    throw binaryFileError(filePath);
  }
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

function readTextWindow(
  fd: number,
  filePath: string,
  options: NormalizedReadOptions,
): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let lineBuffer = "";
  let lineBytes = 0;
  let lineNumber = 1;
  let countedLines = 0;
  let content = "";
  let outputBytes = 0;
  let outputLines = 0;
  let truncated = false;
  let truncatedReason: "budget" | "line-limit" = "budget";
  let firstLineExceedsLimit = false;
  let keepReading = true;
  let hasCurrentLineContent = false;

  const finishLine = (): void => {
    countedLines = lineNumber;
    lineNumber++;
    hasCurrentLineContent = false;
  };

  const flushOutputLine = (): void => {
    content += lineBuffer;
    outputBytes += lineBytes;
    outputLines++;
    lineBuffer = "";
    lineBytes = 0;
    finishLine();
  };

  const consumeLinePiece = (piece: string, completesLine: boolean): void => {
    if (piece !== "") {
      hasCurrentLineContent = true;
    }

    if (lineNumber < options.offset) {
      if (completesLine) {
        finishLine();
      }
      return;
    }

    if (outputLines >= options.limit) {
      truncated = true;
      truncatedReason = "line-limit";
      keepReading = false;
      return;
    }

    const pieceBytes = Buffer.byteLength(piece, "utf8");
    const projectedLineBytes = lineBytes + pieceBytes;
    if (outputBytes + projectedLineBytes > MAX_READ_BYTES) {
      truncated = true;
      truncatedReason = "budget";
      firstLineExceedsLimit = outputLines === 0;
      keepReading = false;
      return;
    }

    lineBuffer += piece;
    lineBytes = projectedLineBytes;

    if (completesLine) {
      flushOutputLine();
    }
  };

  const consumeText = (text: string): void => {
    let cursor = 0;
    while (keepReading) {
      const newlineIndex = text.indexOf("\n", cursor);
      if (newlineIndex < 0) {
        const piece = text.slice(cursor);
        if (piece !== "") {
          consumeLinePiece(piece, false);
        }
        break;
      }

      consumeLinePiece(text.slice(cursor, newlineIndex + 1), true);
      cursor = newlineIndex + 1;
    }
  };

  while (keepReading) {
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;

    const bytes = chunk.subarray(0, bytesRead);
    if (hasBinaryControlBytes(bytes)) {
      throw binaryFileError(filePath);
    }

    consumeText(decodeUtf8(filePath, decoder, bytes, { stream: true }));
  }

  if (keepReading) {
    const remaining = decodeUtf8(filePath, decoder);
    if (remaining !== "") {
      consumeText(remaining);
    }
    if (keepReading && hasCurrentLineContent) {
      if (lineNumber < options.offset) {
        finishLine();
      } else {
        flushOutputLine();
      }
    }
  }

  if (
    countedLines < options.offset &&
    options.offset !== 1 &&
    outputLines === 0
  ) {
    throw new KeelError(
      "tool_read_offset_out_of_range",
      `read failed: offset ${options.offset} is beyond end of file (${countedLines} lines)`,
    );
  }

  if (firstLineExceedsLimit) {
    return `[Read output truncated: line ${options.offset} exceeds ${formatSize(
      MAX_READ_BYTES,
    )}. Use grep to find a smaller target before reading this file.]`;
  }

  return truncated
    ? appendTruncationNotice(content, options, outputLines, truncatedReason)
    : content;
}

export function executeRead(
  workspace: string,
  filePath: string,
  options: ReadOptions = {},
): ToolResult {
  const workspacePath = realpathSync(workspace);
  const requestedPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(workspacePath, filePath);
  if (!existsSync(requestedPath)) {
    throw new KeelError(
      "tool_file_not_found",
      `read failed: file not found: ${filePath}`,
    );
  }

  const targetPath = realpathSync(requestedPath);

  if (!isInsideWorkspace(workspacePath, targetPath)) {
    throw new KeelError(
      "tool_path_outside_workspace",
      `read failed: path is outside the workspace: ${filePath}`,
    );
  }

  const stat = statSync(targetPath);
  if (!stat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `read failed: not a file: ${filePath}`,
    );
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (projectIgnorePolicy.isIgnored(targetPath, false)) {
    throw new KeelError(
      "tool_path_ignored",
      `read failed: ignored path: ${filePath}`,
    );
  }

  const normalizedOptions = normalizeReadOptions(filePath, options);
  const fd = openSync(targetPath, "r");
  try {
    const sample = readSample(fd, stat.size);
    if (isBinarySample(targetPath, sample)) {
      throw binaryFileError(filePath);
    }

    return { content: readTextWindow(fd, filePath, normalizedOptions) };
  } finally {
    closeSync(fd);
  }
}
