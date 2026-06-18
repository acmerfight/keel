import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { KeelError } from "../core/error.ts";

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

export function binaryFileError(
  command: "edit" | "read",
  filePath: string,
): KeelError {
  const action = command === "edit" ? "edited" : "read";
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

export function isBinarySample(filePath: string, sample: Uint8Array): boolean {
  return (
    BINARY_EXTENSIONS.has(extname(filePath).toLowerCase()) ||
    hasMagicBinaryHeader(sample) ||
    hasBinaryControlBytes(sample)
  );
}

export function decodeUtf8(
  command: "edit" | "read",
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

export interface EditableTextFile {
  readonly content: string;
  readonly hasUtf8Bom: boolean;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export function readEditableTextFileWithMetadata(
  targetPath: string,
  filePath: string,
): EditableTextFile {
  const bytes = readFileSync(targetPath);
  const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES);
  if (isBinarySample(targetPath, sample) || hasBinaryControlBytes(bytes)) {
    throw binaryFileError("edit", filePath);
  }

  return {
    content: decodeUtf8(
      "edit",
      filePath,
      new TextDecoder("utf-8", { fatal: true }),
      bytes,
    ),
    hasUtf8Bom: hasUtf8Bom(bytes),
  };
}
