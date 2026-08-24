import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { errorMessage } from "./error.ts";

const ALLOWED_AMBIENT_ANCESTOR_SYMLINK_TARGETS = new Map<string, string>([
  ["/var", "/private/var"],
  ["/tmp", "/private/tmp"],
  ["/etc", "/private/etc"],
]);

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
  | {
      readonly status: "file";
      readonly identity: FilesystemIdentity;
      readonly size: number;
    };

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

function isAllowedAmbientAncestorSymlink(path: string): boolean {
  const expectedTarget = ALLOWED_AMBIENT_ANCESTOR_SYMLINK_TARGETS.get(path);
  if (expectedTarget === undefined) return false;
  try {
    return realpathSync(path) === expectedTarget;
  } catch {
    /* v8 ignore next -- realpath failure after lstat reports a known ambient symlink is an OS race. */
    return false;
  }
}

function ancestorDirectories(path: string): readonly string[] {
  const absolutePath = resolve(path);
  const parsed = parse(absolutePath);
  const relativePath = absolutePath.slice(parsed.root.length);
  const segments = relativePath.split(sep);
  const ancestors: string[] = [];
  let current = parsed.root;
  for (const segment of segments.slice(0, -1)) {
    /* v8 ignore next -- resolve()+path.parse() eliminate empty path segments. */
    if (segment === "") continue;
    current = join(current, segment);
    ancestors.push(current);
  }
  return ancestors;
}

function directoryComponents(path: string): readonly string[] {
  const absolutePath = resolve(path);
  const parsed = parse(absolutePath);
  const relativePath = absolutePath.slice(parsed.root.length);
  const segments = relativePath.split(sep);
  const components: string[] = [];
  let current = parsed.root;
  for (const segment of segments) {
    /* v8 ignore next -- resolve()+path.parse() eliminate empty path segments. */
    if (segment === "") continue;
    current = join(current, segment);
    components.push(current);
  }
  return components;
}

function inspectExistingAncestorDirectories(
  path: string,
  label: string,
): DirectoryIdentity[] {
  const identities: DirectoryIdentity[] = [];
  for (const ancestor of ancestorDirectories(path)) {
    let stats: ReturnType<typeof lstatSync> | undefined;
    try {
      stats = lstatSync(ancestor, { throwIfNoEntry: false });
    } catch (error) {
      privateStateError(
        "io",
        `cannot inspect ${label} ancestor ${ancestor}: ${errorMessage(error)}.`,
      );
    }
    if (stats === undefined) break;
    if (stats.isSymbolicLink()) {
      if (isAllowedAmbientAncestorSymlink(ancestor)) continue;
      privateStateError(
        "symbolic_link",
        `${label} ancestor ${ancestor} must not be a symbolic link.`,
      );
    }
    if (!stats.isDirectory()) {
      privateStateError(
        "not_directory",
        `${label} ancestor ${ancestor} is not a directory.`,
      );
    }
    identities.push({ path: ancestor, ...filesystemIdentity(stats) });
  }
  return identities;
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

export function privateStatePath(
  runtime: PrivateStateRuntime,
  segments: readonly string[],
): string {
  return join(configuredPrivateStateRoot(runtime), ...segments);
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
  if (recursive) {
    createDirectoryChain(path, label);
    return;
  }
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

function createDirectoryChain(path: string, label: string): void {
  const components = directoryComponents(path);
  for (const [index, component] of components.entries()) {
    const componentLabel =
      index === components.length - 1 ? label : `${label} ancestor`;
    let inspection: DirectoryInspection;
    try {
      inspection = inspectDirectory(component, componentLabel);
    } catch (error) {
      /* v8 ignore next 7 -- post-mkdir symlink races exercise the same fail-closed branch below. */
      if (
        error instanceof PrivateStateError &&
        error.reason === "symbolic_link" &&
        isAllowedAmbientAncestorSymlink(component)
      ) {
        continue;
      }
      /* v8 ignore next -- post-mkdir symlink races exercise the same fail-closed branch below. */
      throw error;
    }
    if (inspection.status === "directory") continue;
    try {
      mkdirSync(component, { mode: 0o700 });
    } catch (error) {
      if (!hasNodeErrorCode(error, "EEXIST")) {
        privateStateError(
          "io",
          `cannot create ${componentLabel} ${component}: ${errorMessage(error)}.`,
        );
      }
    }
    try {
      inspection = inspectDirectory(component, componentLabel);
    } catch (error) {
      /* v8 ignore next 7 -- ambient symlink aliases are established OS paths, not newly created components. */
      if (
        error instanceof PrivateStateError &&
        error.reason === "symbolic_link" &&
        isAllowedAmbientAncestorSymlink(component)
      ) {
        continue;
      }
      throw error;
    }
    /* v8 ignore next 5 -- mkdir followed by missing/non-directory requires a filesystem race after the EEXIST-safe create. */
    if (inspection.status !== "directory") {
      privateStateError(
        "not_directory",
        `${componentLabel} ${component} is not a directory.`,
      );
    }
  }
}

function validatePrivateDirectoryPath(
  path: string,
  label: string,
  ensure: boolean,
  recursive: boolean,
): ValidatedDirectory {
  let identities = inspectExistingAncestorDirectories(path, label);
  let inspection = inspectDirectory(path, label);
  if (inspection.status === "missing" && ensure) {
    createDirectory(path, label, recursive);
    identities = inspectExistingAncestorDirectories(path, label);
    inspection = inspectDirectory(path, label);
  }
  const exists = inspection.status === "directory";
  if (inspection.status === "directory") {
    identities.push({ path, ...inspection.identity });
  }
  return { exists, identities, path };
}

export function ensurePrivateDirectory(path: string, label: string): string {
  return validatePrivateDirectoryPath(path, label, true, true).path;
}

export function requirePrivateDirectory(path: string, label: string): string {
  if (!validatePrivateDirectoryPath(path, label, false, false).exists) {
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
  const root = validatePrivateDirectoryPath(
    configuredPrivateStateRoot(runtime),
    "KEEL_HOME",
    ensure,
    true,
  );
  const identities: DirectoryIdentity[] = [...root.identities];
  let path = root.path;
  let exists = root.exists;
  for (const segment of segments) {
    path = join(path, segment);
    if (!exists) continue;
    let inspection = inspectDirectory(path, label);
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

function privateFilePathFromPath(options: {
  readonly path: string;
  readonly label: string;
  readonly ensureParent: boolean;
}): ValidatedDirectory & { readonly filePath: string } {
  const directory = validatePrivateDirectoryPath(
    dirname(options.path),
    `${options.label} parent`,
    options.ensureParent,
    true,
  );
  return { ...directory, filePath: options.path };
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
  return {
    status: "file",
    identity: filesystemIdentity(stats),
    size: stats.size,
  };
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

function syncDirectory(path: string, label: string): void {
  /* v8 ignore next -- Windows cannot fsync directory handles. */
  if (process.platform === "win32") return;
  const directory = validatePrivateDirectoryPath(path, label, false, false);
  /* v8 ignore next 3 -- callers validate or create the parent immediately before syncing it. */
  if (!directory.exists) {
    privateStateError("not_directory", `${label} ${path} does not exist.`);
  }
  let fd: number | undefined;
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      /* v8 ignore next -- directory-open faults require OS/filesystem fault injection. */
      privateFileOpenError(path, label, error);
    }
    fsyncSync(fd);
  } finally {
    /* v8 ignore next -- fd is only undefined when the ignored directory-open fault branch throws before assignment. */
    if (fd !== undefined) closeSync(fd);
  }
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

export function readPrivateFile(options: {
  readonly path: string;
  readonly label: string;
}): string | null {
  const validated = privateFilePathFromPath({
    ...options,
    ensureParent: false,
  });
  if (!validated.exists) return null;
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "missing") return null;
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        options.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) return null;
      privateFileOpenError(options.path, options.label, error);
    }
    assertOpenedPrivateFile(
      options.path,
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

export function readPrivateFileBuffer(options: {
  readonly path: string;
  readonly label: string;
}): Buffer | null {
  const validated = privateFilePathFromPath({
    ...options,
    ensureParent: false,
  });
  if (!validated.exists) return null;
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "missing") return null;
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        options.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) return null;
      privateFileOpenError(options.path, options.label, error);
    }
    assertOpenedPrivateFile(
      options.path,
      options.label,
      fd,
      inspection.identity,
      validated.identities,
    );
    return readFileSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function privateFileSize(options: {
  readonly path: string;
  readonly label: string;
}): number | null {
  const validated = privateFilePathFromPath({
    ...options,
    ensureParent: false,
  });
  if (!validated.exists) return null;
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "missing") return null;
  return inspection.size;
}

export function replacePrivateStateFile(options: {
  readonly runtime: PrivateStateRuntime;
  readonly segments: readonly string[];
  readonly label: string;
  readonly content: string;
}): void {
  const validated = privateFilePath({ ...options, ensureParent: true });
  replacePrivateFile({
    path: validated.filePath,
    label: options.label,
    content: options.content,
  });
}

export function replacePrivateFile(options: {
  readonly path: string;
  readonly label: string;
  readonly content: string;
}): void {
  const validated = privateFilePathFromPath({
    ...options,
    ensureParent: true,
  });
  inspectPrivateFile(options.path, options.label);
  const temporaryPath = join(
    validated.path,
    `.${basename(options.path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const result = createPrivateFile({
      path: temporaryPath,
      label: `${options.label} temporary file`,
      content: options.content,
    });
    /* v8 ignore next 5 -- the temporary name includes pid and random UUID; collision handling is still fail-closed. */
    if (result.status === "exists") {
      privateStateError(
        "io",
        `${options.label} temporary file ${temporaryPath} already exists.`,
      );
    }
    renameSync(temporaryPath, options.path);
    inspectPrivateFile(options.path, options.label);
    syncDirectory(validated.path, `${options.label} parent`);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      /* v8 ignore next -- cleanup is best effort; preserve the publication failure. */
      // Preserve the publication failure; the unique temp file is inert.
    }
    /* v8 ignore next -- preserve normalized private-state reasons from publication/sync failures. */
    if (error instanceof PrivateStateError) throw error;
    privateStateError(
      "io",
      `cannot replace ${options.label} ${options.path}: ${errorMessage(error)}.`,
    );
  }
}

export function truncatePrivateFile(options: {
  readonly path: string;
  readonly label: string;
  readonly size: number;
}): void {
  const validated = privateFilePathFromPath({
    path: options.path,
    label: options.label,
    ensureParent: false,
  });
  if (!validated.exists) {
    privateStateError(
      "not_directory",
      `${options.label} parent ${dirname(options.path)} does not exist.`,
    );
  }
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "missing") {
    privateStateError("not_file", `${options.label} ${options.path} missing.`);
  }
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        options.path,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      privateFileOpenError(options.path, options.label, error);
    }
    assertOpenedPrivateFile(
      options.path,
      options.label,
      fd,
      inspection.identity,
      validated.identities,
    );
    ftruncateSync(fd, options.size);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readPrivateFileBufferRange(options: {
  readonly path: string;
  readonly label: string;
  readonly start: number;
  readonly length: number;
}): Buffer | null {
  const validated = privateFilePathFromPath({
    path: options.path,
    label: options.label,
    ensureParent: false,
  });
  if (!validated.exists) return null;
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "missing") return null;
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        options.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) return null;
      privateFileOpenError(options.path, options.label, error);
    }
    assertOpenedPrivateFile(
      options.path,
      options.label,
      fd,
      inspection.identity,
      validated.identities,
    );
    const buffer = Buffer.alloc(options.length);
    let offset = 0;
    while (offset < options.length) {
      const bytesRead = readSync(
        fd,
        buffer,
        offset,
        options.length - offset,
        options.start + offset,
      );
      if (bytesRead === 0) {
        privateStateError(
          "io",
          `cannot read ${options.label} ${options.path}: unexpected end of file.`,
        );
      }
      offset += bytesRead;
    }
    return buffer;
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

export function createPrivateFile(options: {
  readonly path: string;
  readonly label: string;
  readonly content: string;
}): { readonly status: "created" | "exists" } {
  const validated = privateFilePathFromPath({
    ...options,
    ensureParent: true,
  });
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "file") return { status: "exists" };
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        options.path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) return { status: "exists" };
      privateFileOpenError(options.path, options.label, error);
    }
    assertOpenedPrivateFile(
      options.path,
      options.label,
      fd,
      null,
      validated.identities,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, options.content, "utf8");
    fsyncSync(fd);
    return { status: "created" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function appendPrivateFile(options: {
  readonly path: string;
  readonly label: string;
  readonly content: string;
}): void {
  const validated = privateFilePathFromPath({
    ...options,
    ensureParent: false,
  });
  if (!validated.exists) {
    privateStateError(
      "not_directory",
      `${options.label} parent ${dirname(options.path)} does not exist.`,
    );
  }
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "missing") {
    privateStateError("not_file", `${options.label} ${options.path} missing.`);
  }
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        options.path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
    } catch (error) {
      privateFileOpenError(options.path, options.label, error);
    }
    assertOpenedPrivateFile(
      options.path,
      options.label,
      fd,
      inspection.identity,
      validated.identities,
    );
    appendFileSync(fd, options.content, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function removePrivateFile(options: {
  readonly path: string;
  readonly label: string;
}): boolean {
  const validated = privateFilePathFromPath({
    ...options,
    ensureParent: false,
  });
  if (!validated.exists) return false;
  const inspection = inspectPrivateFile(options.path, options.label);
  if (inspection.status === "missing") return false;
  try {
    unlinkSync(options.path);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return false;
    privateStateError(
      "io",
      `cannot remove ${options.label} ${options.path}: ${errorMessage(error)}.`,
    );
  }
}
