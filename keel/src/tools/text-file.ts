import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";
import { KeelError } from "../core/error.ts";
import { type FileRevision, fileRevisionFromBytes } from "./file-revision.ts";

export const BINARY_SAMPLE_BYTES = 4096;

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

type TextFileCommand = "apply_patch" | "edit" | "read";
type EditableTextFileCommand = Exclude<TextFileCommand, "read">;

function binaryFileAction(command: TextFileCommand): string {
  if (command === "apply_patch") return "patched";
  return command === "edit" ? "edited" : "read";
}

export function binaryFileError(
  command: TextFileCommand,
  filePath: string,
): KeelError {
  const action = binaryFileAction(command);
  return new KeelError(
    "tool_binary_file",
    `${command} failed: binary file is not supported: ${filePath}`,
    `This is a binary file and cannot be ${action} as text. Use grep to search for text in nearby source files instead.`,
  );
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

export function hasBinaryControlBytes(bytes: Uint8Array): boolean {
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

function hasInvalidUtf8(
  sample: Uint8Array,
  sampleIsComplete: boolean,
): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: !sampleIsComplete,
    });
    return false;
  } catch {
    return true;
  }
}

export function isBinaryContentSample(
  sample: Uint8Array,
  sampleIsComplete = false,
): boolean {
  return (
    hasMagicBinaryHeader(sample) ||
    hasBinaryControlBytes(sample) ||
    hasInvalidUtf8(sample, sampleIsComplete)
  );
}

export function isBinarySample(filePath: string, sample: Uint8Array): boolean {
  return (
    BINARY_EXTENSIONS.has(extname(filePath).toLowerCase()) ||
    isBinaryContentSample(sample)
  );
}

export function decodeUtf8(
  command: TextFileCommand,
  filePath: string,
  decoder: TextDecoder,
  input?: Uint8Array,
  options?: TextDecodeOptions,
): string {
  try {
    return decoder.decode(input, options);
  } catch {
    throw binaryFileError(command, filePath);
  }
}

export interface EditableTextFile<OpenedMetadata = undefined> {
  readonly content: string;
  readonly fileRevision: FileRevision;
  readonly hasUtf8Bom: boolean;
  readonly targetPath: string;
  readonly openedMetadata: OpenedMetadata;
}

export interface OpenedFileValidation<OpenedMetadata> {
  readonly targetPath: string;
  readonly metadata: OpenedMetadata;
}

export interface ReadEditableTextFileOptions<OpenedMetadata> {
  readonly command?: EditableTextFileCommand;
  readonly maxBytes: number;
  readonly tooLargeError: (observedBytes: number) => KeelError;
  readonly validateOpenedFile: (
    fd: number,
  ) => OpenedFileValidation<OpenedMetadata>;
}

interface ReadFileCappedResult<OpenedMetadata> {
  readonly bytes: Buffer;
  readonly targetPath: string;
  readonly openedMetadata: OpenedMetadata;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function readFileCapped<OpenedMetadata>(
  targetPath: string,
  maxBytes: number,
  validateOpenedFile: (
    fd: number,
  ) => OpenedFileValidation<OpenedMetadata>,
): ReadFileCappedResult<OpenedMetadata> {
  const readLimit = maxBytes + 1;
  const chunks: Buffer[] = [];
  let offset = 0;
  const fd = openSync(targetPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = validateOpenedFile(fd);
    const reportedSize = fstatSync(fd).size;
    let nextChunkSize = Math.min(Math.max(reportedSize + 1, 1), readLimit);
    while (offset < readLimit) {
      const chunk = Buffer.allocUnsafe(
        Math.min(nextChunkSize, readLimit - offset),
      );
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      offset += read;
      if (read < chunk.length) break;
      nextChunkSize = Math.min(Math.max(nextChunkSize * 2, 1), readLimit);
    }
    return {
      bytes: Buffer.concat(chunks, offset),
      targetPath: opened.targetPath,
      openedMetadata: opened.metadata,
    };
  } finally {
    closeSync(fd);
  }
}

export function readEditableTextFileWithMetadata<OpenedMetadata>(
  targetPath: string,
  filePath: string,
  options: ReadEditableTextFileOptions<OpenedMetadata>,
): EditableTextFile<OpenedMetadata> {
  const command = options.command ?? "edit";
  const {
    bytes,
    targetPath: openedTargetPath,
    openedMetadata,
  } = readFileCapped(
    targetPath,
    options.maxBytes,
    options.validateOpenedFile,
  );
  if (bytes.length > options.maxBytes) {
    throw options.tooLargeError(bytes.length);
  }
  const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES);
  if (isBinarySample(targetPath, sample) || hasBinaryControlBytes(bytes)) {
    throw binaryFileError(command, filePath);
  }

  return {
    content: decodeUtf8(
      command,
      filePath,
      new TextDecoder("utf-8", { fatal: true }),
      bytes,
    ),
    fileRevision: fileRevisionFromBytes(bytes),
    hasUtf8Bom: hasUtf8Bom(bytes),
    targetPath: openedTargetPath,
    openedMetadata,
  };
}
