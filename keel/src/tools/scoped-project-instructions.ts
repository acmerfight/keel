import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { KeelError } from "../core/error.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import {
  BINARY_SAMPLE_BYTES,
  decodeUtf8,
  hasBinaryControlBytes,
  isBinarySample,
} from "./text-file.ts";
import { isInsideWorkspace, resolveWorkspaceTarget } from "./workspace-path.ts";

const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_PROJECT_INSTRUCTIONS_BYTES = 50 * 1024;

interface ScopedProjectInstructionsFile {
  readonly path: string;
  readonly relativePath: string;
  readonly content: string;
}

interface ScopedProjectInstructionsOutput {
  readonly content: string;
  readonly instructionPaths: readonly string[];
}

interface VisibleProjectInstructionSnapshot {
  readonly instructionPath: string;
  readonly relativePath: string;
}

export interface ProjectInstructionVisibilityState {
  readonly formatReadOutput: (
    targetPath: string,
    content: string,
  ) => ScopedProjectInstructionsOutput;
  readonly formatRestoreOutput: (
    snapshot: VisibleProjectInstructionSnapshot,
  ) => ScopedProjectInstructionsOutput | null;
  readonly assertMutationAllowed: (targetPaths: readonly string[]) => void;
  readonly visibleInstructionsMostRecentFirst: () => readonly VisibleProjectInstructionSnapshot[];
  readonly markInstructionPathsVisible: (
    instructionPaths: readonly string[],
  ) => void;
  readonly applyMutationTargetPaths: (targetPaths: readonly string[]) => void;
  readonly clear: () => void;
}

export class ScopedProjectInstructionsNotVisibleError extends KeelError {
  readonly instructionPaths: readonly string[];

  constructor(instructionPaths: readonly string[], instructionsBlock: string) {
    super(
      "tool_project_instructions_not_visible",
      `project instructions have not been reviewed for this path:\n\n${instructionsBlock}`,
      "Review the project instructions above, then retry the tool call only if it still follows them.",
    );
    this.instructionPaths = instructionPaths;
  }
}

function projectInstructionsTooLargeError(
  relativePath: string,
  observedBytes: number,
): KeelError {
  return new KeelError(
    "tool_file_too_large",
    `project instructions failed: ${relativePath} is too large (${observedBytes} bytes; limit ${MAX_PROJECT_INSTRUCTIONS_BYTES} bytes)`,
    "Ask the user to shrink AGENTS.md before editing files in this scope.",
  );
}

function projectInstructionsBinaryError(relativePath: string): KeelError {
  return new KeelError(
    "tool_binary_file",
    `project instructions failed: ${relativePath} is binary or invalid UTF-8`,
    "Ask the user to replace AGENTS.md with UTF-8 text before editing files in this scope.",
  );
}

function projectInstructionsNotFileError(relativePath: string): KeelError {
  return new KeelError(
    "tool_not_file",
    `project instructions failed: ${relativePath} is not a regular file`,
    "Ask the user to make AGENTS.md a regular UTF-8 text file before editing files in this scope.",
  );
}

function pathExists(filePath: string): boolean {
  return lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function readProjectInstructionsBytes(
  targetPath: string,
  relativePath: string,
): Buffer {
  const fd = openSync(targetPath, "r");
  try {
    const reportedSize = fstatSync(fd).size;
    if (reportedSize > MAX_PROJECT_INSTRUCTIONS_BYTES) {
      throw projectInstructionsTooLargeError(relativePath, reportedSize);
    }
    const bytes = Buffer.allocUnsafe(reportedSize);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function decodeProjectInstructions(
  bytes: Uint8Array,
  relativePath: string,
): string {
  try {
    return decodeUtf8(
      "read",
      relativePath,
      new TextDecoder("utf-8", { fatal: true }),
      bytes,
    );
  } catch {
    throw projectInstructionsBinaryError(relativePath);
  }
}

function loadScopedProjectInstructionsFile(
  workspacePath: string,
  relativePath: string,
): ScopedProjectInstructionsFile | undefined {
  const candidatePath = join(workspacePath, relativePath);
  if (!pathExists(candidatePath)) {
    return undefined;
  }

  const target = resolveWorkspaceTarget(workspacePath, relativePath, "read");
  const targetStat = statSync(target.targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(target.workspacePath);
  if (
    projectIgnorePolicy.isIgnored(target.requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(target.targetPath, targetIsDirectory)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `project instructions failed: ignored path: ${relativePath}`,
      "Ask the user to unignore AGENTS.md or choose a file outside this ignored scope.",
    );
  }
  if (!targetStat.isFile()) {
    throw projectInstructionsNotFileError(relativePath);
  }

  const bytes = readProjectInstructionsBytes(target.targetPath, relativePath);
  const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES);
  if (
    isBinarySample(target.targetPath, sample) ||
    hasBinaryControlBytes(bytes)
  ) {
    throw projectInstructionsBinaryError(relativePath);
  }
  const content = decodeProjectInstructions(bytes, relativePath).trimEnd();
  if (content === "") {
    return undefined;
  }
  return {
    path: target.targetPath,
    relativePath,
    content,
  };
}

function targetDirectoryForInstructions(targetPath: string): string {
  return dirname(targetPath);
}

function relativeTargetDirectory(
  workspacePath: string,
  targetPath: string,
): string | null {
  const targetDir = targetDirectoryForInstructions(targetPath);
  const targetDirFromWorkspace = relative(workspacePath, targetDir);
  if (
    targetDirFromWorkspace.startsWith("..") ||
    isAbsolute(targetDirFromWorkspace)
  ) {
    return null;
  }
  return targetDirFromWorkspace;
}

function candidateInstructionRelativePaths(
  workspacePath: string,
  targetPath: string,
): readonly string[] {
  const targetDirFromWorkspace = relativeTargetDirectory(
    workspacePath,
    targetPath,
  );
  if (targetDirFromWorkspace === null || targetDirFromWorkspace === "") {
    return [];
  }

  const relativePaths: string[] = [];
  const segments = targetDirFromWorkspace
    .split(sep)
    .filter((segment) => segment !== "");
  let currentRelativePath = "";
  for (const segment of segments) {
    currentRelativePath =
      currentRelativePath === "" ? segment : join(currentRelativePath, segment);
    relativePaths.push(join(currentRelativePath, PROJECT_INSTRUCTIONS_FILE));
  }
  return relativePaths;
}

function applicableProjectInstructions(
  workspacePath: string,
  targetPath: string,
): readonly ScopedProjectInstructionsFile[] {
  if (!isInsideWorkspace(workspacePath, targetPath)) {
    return [];
  }

  const instructions: ScopedProjectInstructionsFile[] = [];
  for (const relativePath of candidateInstructionRelativePaths(
    workspacePath,
    targetPath,
  )) {
    const file = loadScopedProjectInstructionsFile(workspacePath, relativePath);
    if (file !== undefined) {
      instructions.push(file);
    }
  }
  return instructions;
}

function quotedInstructionContent(content: string): string {
  return content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatProjectInstructionsBlock(
  instructions: readonly ScopedProjectInstructionsFile[],
): string {
  return instructions
    .map((instruction) =>
      [
        `Project instructions from ${instruction.relativePath} apply to this path:`,
        quotedInstructionContent(instruction.content),
      ].join("\n"),
    )
    .join("\n\n");
}

function missingVisibleInstructions(
  visibleInstructionPaths: ReadonlySet<string>,
  instructions: readonly ScopedProjectInstructionsFile[],
): readonly ScopedProjectInstructionsFile[] {
  return instructions.filter(
    (instruction) => !visibleInstructionPaths.has(instruction.path),
  );
}

function uniqueInstructionsByPath(
  instructions: readonly ScopedProjectInstructionsFile[],
): readonly ScopedProjectInstructionsFile[] {
  const seen = new Set<string>();
  const unique: ScopedProjectInstructionsFile[] = [];
  for (const instruction of instructions) {
    if (seen.has(instruction.path)) continue;
    seen.add(instruction.path);
    unique.push(instruction);
  }
  return unique;
}

export function createProjectInstructionVisibilityState(
  workspace: string,
): ProjectInstructionVisibilityState {
  const workspacePath = realpathSync(workspace);
  const visibleInstructions = new Map<
    string,
    VisibleProjectInstructionSnapshot
  >();

  const visibleInstructionPaths = (): ReadonlySet<string> =>
    new Set(visibleInstructions.keys());

  const snapshotForInstructionPath = (
    instructionPath: string,
  ): VisibleProjectInstructionSnapshot | null => {
    const relativePath = relative(workspacePath, instructionPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return null;
    }
    return { instructionPath, relativePath };
  };

  const missingInstructionsForTargets = (
    targetPaths: readonly string[],
  ): readonly ScopedProjectInstructionsFile[] =>
    uniqueInstructionsByPath(
      targetPaths.flatMap((targetPath) =>
        missingVisibleInstructions(
          visibleInstructionPaths(),
          applicableProjectInstructions(workspacePath, targetPath),
        ),
      ),
    );

  return {
    formatReadOutput: (targetPath, content) => {
      const missingInstructions = missingInstructionsForTargets([targetPath]);
      if (missingInstructions.length === 0) {
        return { content, instructionPaths: [] };
      }
      return {
        content: [
          formatProjectInstructionsBlock(missingInstructions),
          content,
        ].join("\n\n"),
        instructionPaths: missingInstructions.map(
          (instruction) => instruction.path,
        ),
      };
    },
    formatRestoreOutput: (snapshot) => {
      const file = loadScopedProjectInstructionsFile(
        workspacePath,
        snapshot.relativePath,
      );
      if (file === undefined) {
        return null;
      }
      return {
        content: formatProjectInstructionsBlock([file]),
        instructionPaths: [file.path],
      };
    },
    assertMutationAllowed: (targetPaths) => {
      const missingInstructions = missingInstructionsForTargets(targetPaths);
      if (missingInstructions.length === 0) {
        return;
      }
      throw new ScopedProjectInstructionsNotVisibleError(
        missingInstructions.map((instruction) => instruction.path),
        formatProjectInstructionsBlock(missingInstructions),
      );
    },
    visibleInstructionsMostRecentFirst: () =>
      [...visibleInstructions.values()].reverse(),
    markInstructionPathsVisible: (instructionPaths) => {
      for (const instructionPath of instructionPaths) {
        const snapshot = snapshotForInstructionPath(instructionPath);
        if (snapshot === null) {
          continue;
        }
        visibleInstructions.delete(instructionPath);
        visibleInstructions.set(instructionPath, snapshot);
      }
    },
    applyMutationTargetPaths: (targetPaths) => {
      for (const targetPath of targetPaths) {
        if (targetPath.endsWith(`${sep}${PROJECT_INSTRUCTIONS_FILE}`)) {
          visibleInstructions.delete(targetPath);
        }
      }
    },
    clear: () => visibleInstructions.clear(),
  };
}
