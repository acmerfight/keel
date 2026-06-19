import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ProjectInstructions } from "../agent/prompt.ts";
import { createProjectIgnorePolicy } from "../tools/project-ignore.ts";
import {
  BINARY_SAMPLE_BYTES,
  hasBinaryControlBytes,
  isBinarySample,
} from "../tools/text-file.ts";
import { resolveWorkspaceTarget } from "../tools/workspace-path.ts";

const ROOT_PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_PROJECT_INSTRUCTIONS_BYTES = 50 * 1024;

export class ProjectInstructionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectInstructionsError";
  }
}

function projectInstructionsTooLargeError(observedBytes: number): Error {
  return new ProjectInstructionsError(
    `Error: AGENTS.md is too large to inject automatically (${observedBytes} bytes; limit ${MAX_PROJECT_INSTRUCTIONS_BYTES} bytes).`,
  );
}

function projectInstructionsBinaryError(): Error {
  return new ProjectInstructionsError(
    "Error: AGENTS.md is binary or not valid UTF-8 text, so it cannot be injected as project instructions.",
  );
}

function projectInstructionsNotFileError(): Error {
  return new ProjectInstructionsError(
    "Error: AGENTS.md must be a regular file to be injected as project instructions.",
  );
}

function projectInstructionsIgnoredError(): Error {
  return new ProjectInstructionsError(
    "Error: cannot load AGENTS.md project instructions: ignored path.",
  );
}

function projectInstructionsResolveError(error: unknown): Error {
  return new ProjectInstructionsError(
    `Error: cannot load AGENTS.md project instructions: ${String(error).replace(
      /^Error: /u,
      "",
    )}`,
  );
}

function projectInstructionsPathExists(filePath: string): boolean {
  return lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

function readProjectInstructionsBytes(targetPath: string): Buffer {
  const fd = openSync(targetPath, "r");
  try {
    const reportedSize = fstatSync(fd).size;
    if (reportedSize > MAX_PROJECT_INSTRUCTIONS_BYTES) {
      throw projectInstructionsTooLargeError(reportedSize);
    }
    const bytes = Buffer.allocUnsafe(reportedSize);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function decodeProjectInstructions(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw projectInstructionsBinaryError();
  }
}

export function loadProjectInstructions(
  workspace: string,
): ProjectInstructions | undefined {
  const filePath = join(workspace, ROOT_PROJECT_INSTRUCTIONS_FILE);
  if (!projectInstructionsPathExists(filePath)) {
    return undefined;
  }
  const target = (() => {
    try {
      return resolveWorkspaceTarget(
        workspace,
        ROOT_PROJECT_INSTRUCTIONS_FILE,
        "read",
      );
    } catch (error) {
      throw projectInstructionsResolveError(error);
    }
  })();
  const targetStat = statSync(target.targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(target.workspacePath);
  if (
    projectIgnorePolicy.isIgnored(target.requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(target.targetPath, targetIsDirectory)
  ) {
    throw projectInstructionsIgnoredError();
  }
  if (!targetStat.isFile()) {
    throw projectInstructionsNotFileError();
  }
  const bytes = readProjectInstructionsBytes(target.targetPath);
  const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES);
  if (
    isBinarySample(target.targetPath, sample) ||
    hasBinaryControlBytes(bytes)
  ) {
    throw projectInstructionsBinaryError();
  }
  const content = decodeProjectInstructions(bytes).trimEnd();
  if (content === "") {
    return undefined;
  }
  return {
    relativePath: ROOT_PROJECT_INSTRUCTIONS_FILE,
    content,
  };
}
