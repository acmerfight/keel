import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage } from "./error.ts";

export interface PrivateStateRuntime {
  readonly env: (key: string) => string | undefined;
}

export type PrivateStateErrorReason =
  | "hard_link"
  | "invalid_path"
  | "io"
  | "not_directory"
  | "not_file"
  | "symbolic_link";

export class PrivateStateError extends Error {
  readonly reason: PrivateStateErrorReason;

  constructor(reason: PrivateStateErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

interface FilesystemIdentity {
  readonly birthtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}

interface DirectoryIdentity extends FilesystemIdentity {
  readonly path: string;
}

type DirectoryInspection =
  | { readonly status: "missing" }
  | { readonly status: "directory"; readonly identity: FilesystemIdentity };

interface ValidatedDirectory {
  readonly exists: boolean;
  readonly identities: readonly DirectoryIdentity[];
  readonly path: string;
}

type PrivateFileInspection =
  | { readonly status: "missing" }
  | { readonly status: "file"; readonly identity: FilesystemIdentity };

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function privateStateError(
  reason: PrivateStateErrorReason,
  message: string,
): never {
  throw new PrivateStateError(reason, `Error: ${message}`);
}

function filesystemIdentity(stats: {
  readonly birthtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}): FilesystemIdentity {
  return {
    birthtimeMs: stats.birthtimeMs,
    dev: stats.dev,
    ino: stats.ino,
  };
}

function sameFilesystemIdentity(
  left: FilesystemIdentity,
  right: FilesystemIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function inspectDirectory(path: string, label: string): DirectoryInspection {
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    privateStateError(
      "io",
      `cannot inspect ${label} ${path}: ${errorMessage(error)}.`,
    );
  }
  if (stats === undefined) return { status: "missing" };
  if (stats.isSymbolicLink()) {
    privateStateError(
      "symbolic_link",
      `${label} ${path} must not be a symbolic link.`,
    );
  }
  if (!stats.isDirectory()) {
    privateStateError("not_directory", `${label} ${path} is not a directory.`);
  }
  return { status: "directory", identity: filesystemIdentity(stats) };
}

function configuredHome(runtime: PrivateStateRuntime): string {
  return runtime.env("HOME") ?? runtime.env("USERPROFILE") ?? homedir();
}

function configuredPrivateStateRoot(runtime: PrivateStateRuntime): string {
  return runtime.env("KEEL_HOME") ?? join(configuredHome(runtime), ".keel");
}

export function privateStateRootPath(runtime: PrivateStateRuntime): string {
  return configuredPrivateStateRoot(runtime);
}

export function privateStateDirectoryPath(
  runtime: PrivateStateRuntime,
  segments: readonly string[],
  label: string,
): string {
  return validatePrivateStateDirectory(runtime, segments, label, false).path;
}

function createDirectory(
  path: string,
  label: string,
  recursive: boolean,
): void {
  try {
    mkdirSync(path, { recursive, mode: 0o700 });
  } catch (error) {
    if (!hasNodeErrorCode(error, "EEXIST")) {
      privateStateError(
        "io",
        `cannot create ${label} ${path}: ${errorMessage(error)}.`,
      );
    }
  }
  inspectDirectory(path, label);
}

export function ensurePrivateDirectory(path: string, label: string): string {
  inspectDirectory(dirname(path), `${label} parent`);
  if (inspectDirectory(path, label).status === "missing") {
    createDirectory(path, label, true);
  }
  return path;
}

export function requirePrivateDirectory(path: string, label: string): string {
  if (inspectDirectory(path, label).status === "missing") {
    privateStateError("not_directory", `${label} ${path} does not exist.`);
  }
  return path;
}

function validatePrivateStateDirectory(
  runtime: PrivateStateRuntime,
  segments: readonly string[],
  label: string,
  ensure: boolean,
): ValidatedDirectory {
  const identities: DirectoryIdentity[] = [];
  let path = configuredPrivateStateRoot(runtime);
  let inspection = inspectDirectory(path, "KEEL_HOME");
  if (inspection.status === "missing" && ensure) {
    createDirectory(path, "KEEL_HOME", true);
    inspection = inspectDirectory(path, "KEEL_HOME");
  }
  let exists = inspection.status === "directory";
  if (inspection.status === "directory") {
    identities.push({ path, ...inspection.identity });
  }
  for (const segment of segments) {
    path = join(path, segment);
    if (!exists) continue;
    inspection = inspectDirectory(path, label);
    if (inspection.status === "missing" && ensure) {
      createDirectory(path, label, false);
      inspection = inspectDirectory(path, label);
    }
    exists = inspection.status === "directory";
    if (inspection.status === "directory") {
      identities.push({ path, ...inspection.identity });
    }
  }
  return { exists, identities, path };
}

export function ensurePrivateStateDirectory(
  runtime: PrivateStateRuntime,
  segments: readonly string[],
  label: string,
): string {
  return validatePrivateStateDirectory(runtime, segments, label, true).path;
}

function privateFilePath(options: {
  readonly runtime: PrivateStateRuntime;
  readonly segments: readonly string[];
  readonly label: string;
  readonly ensureParent: boolean;
}): ValidatedDirectory & { readonly filePath: string } {
  const fileName = options.segments.at(-1);
  if (fileName === undefined) {
    privateStateError(
      "invalid_path",
      `${options.label} path must name a file.`,
    );
  }
  const directorySegments = options.segments.slice(0, -1);
  const directory = validatePrivateStateDirectory(
    options.runtime,
    directorySegments,
    `${options.label} parent`,
    options.ensureParent,
  );
  return { ...directory, filePath: join(directory.path, fileName) };
}

function inspectPrivateFile(
  path: string,
  label: string,
): PrivateFileInspection {
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    privateStateError(
      "io",
      `cannot inspect ${label} ${path}: ${errorMessage(error)}.`,
    );
  }
  if (stats === undefined) return { status: "missing" };
  if (stats.isSymbolicLink()) {
    privateStateError(
      "symbolic_link",
      `${label} ${path} must not be a symbolic link.`,
    );
  }
  if (!stats.isFile()) {
    privateStateError("not_file", `${label} ${path} must be a regular file.`);
  }
  if (stats.nlink !== 1) {
    privateStateError(
      "hard_link",
      `${label} ${path} must have exactly one hard link.`,
    );
  }
  return { status: "file", identity: filesystemIdentity(stats) };
}

function assertOpenedPrivateFile(
  path: string,
  label: string,
  fd: number,
  expectedIdentity: FilesystemIdentity | null,
  directoryIdentities: readonly DirectoryIdentity[],
): void {
  let stats: ReturnType<typeof fstatSync>;
  try {
    stats = fstatSync(fd);
  } catch (error) {
    privateStateError(
      "io",
      `cannot inspect opened ${label} ${path}: ${errorMessage(error)}.`,
    );
  }
  if (!stats.isFile()) {
    privateStateError("not_file", `${label} ${path} must be a regular file.`);
  }
  if (stats.nlink !== 1) {
    privateStateError(
      "hard_link",
      `${label} ${path} must have exactly one hard link.`,
    );
  }
  const openedIdentity = filesystemIdentity(stats);
  if (
    expectedIdentity !== null &&
    !sameFilesystemIdentity(expectedIdentity, openedIdentity)
  ) {
    privateStateError("io", `${label} ${path} changed during access.`);
  }
  for (const expected of directoryIdentities) {
    let matches = false;
    try {
      const inspection = inspectDirectory(expected.path, `${label} parent`);
      matches =
        inspection.status === "directory" &&
        sameFilesystemIdentity(expected, inspection.identity);
    } catch (error) {
      /* v8 ignore next -- inspectDirectory normalizes every filesystem failure to PrivateStateError. */
      if (!(error instanceof PrivateStateError)) throw error;
    }
    if (!matches) {
      privateStateError(
        "io",
        `${label} parent ${expected.path} changed during access.`,
      );
    }
  }
  let currentMatches = false;
  try {
    const current = inspectPrivateFile(path, label);
    currentMatches =
      current.status === "file" &&
      sameFilesystemIdentity(current.identity, openedIdentity);
  } catch (error) {
    /* v8 ignore next -- inspectPrivateFile normalizes every filesystem failure to PrivateStateError. */
    if (!(error instanceof PrivateStateError)) throw error;
  }
  if (!currentMatches) {
    privateStateError("io", `${label} ${path} changed during access.`);
  }
}

function privateFileOpenError(
  path: string,
  label: string,
  error: unknown,
): never {
  if (hasNodeErrorCode(error, "ELOOP")) {
    privateStateError(
      "symbolic_link",
      `${label} ${path} must not be a symbolic link.`,
    );
  }
  privateStateError(
    "io",
    `cannot open ${label} ${path}: ${errorMessage(error)}.`,
  );
}

export function readPrivateStateFile(options: {
  readonly runtime: PrivateStateRuntime;
  readonly segments: readonly string[];
  readonly label: string;
}): string | null {
  const validated = privateFilePath({ ...options, ensureParent: false });
  if (!validated.exists) return null;
  const path = validated.filePath;
  const inspection = inspectPrivateFile(path, options.label);
  if (inspection.status === "missing") return null;
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) return null;
      privateFileOpenError(path, options.label, error);
    }
    assertOpenedPrivateFile(
      path,
      options.label,
      fd,
      inspection.identity,
      validated.identities,
    );
    return readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writePrivateStateFile(options: {
  readonly runtime: PrivateStateRuntime;
  readonly segments: readonly string[];
  readonly label: string;
  readonly content: string;
}): void {
  // Private files use reject semantics: an existing symlink or shared inode is
  // never replaced, and first publication must win an exclusive create.
  const validated = privateFilePath({ ...options, ensureParent: true });
  const path = validated.filePath;
  const inspection = inspectPrivateFile(path, options.label);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        path,
        inspection.status === "missing"
          ? constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK
          : constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
    } catch (error) {
      privateFileOpenError(path, options.label, error);
    }
    assertOpenedPrivateFile(
      path,
      options.label,
      fd,
      inspection.status === "file" ? inspection.identity : null,
      validated.identities,
    );
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, options.content, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
