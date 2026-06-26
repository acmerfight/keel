import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { WorkflowSkill } from "../agent/prompt.ts";
import {
  BINARY_SAMPLE_BYTES,
  hasBinaryControlBytes,
  isBinarySample,
} from "../tools/text-file.ts";
import {
  isWorkflowSkillResourcePath,
  MAX_WORKFLOW_SKILL_RESOURCE_ENTRY_VISITS,
  MAX_WORKFLOW_SKILL_RESOURCE_PATHS,
  WORKFLOW_SKILL_RESOURCE_DIRECTORIES,
} from "./workflow-skill-contract.ts";

const LOCAL_SKILL_ROOT = join(".agents", "skills");
const SKILL_FILE = "SKILL.md";
const MAX_WORKFLOW_SKILL_BYTES = 50 * 1024;

const skillNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
    "workflow skill names may contain only letters, numbers, dots, underscores, and hyphens, and must not start with punctuation",
  );

const skillFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .passthrough();

export class WorkflowSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSkillError";
  }
}

export interface WorkflowSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
}

export interface WorkflowSkillListWarning {
  readonly name: string;
  readonly message: string;
}

export interface WorkflowSkillListResult {
  readonly skills: readonly WorkflowSkillSummary[];
  readonly warnings: readonly WorkflowSkillListWarning[];
}

interface LocalSkillRoot {
  readonly rootPath: string;
  readonly displayBasePath: string;
}

type LocalSkillRootStatus = "missing" | "directory" | "not-directory";

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function localSkillRootStatus(path: string): LocalSkillRootStatus {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    return "missing";
  }
  return stat.isDirectory() ? "directory" : "not-directory";
}

function findProjectRoot(workspace: string): string {
  const resolvedWorkspace = resolve(workspace);
  let projectRoot: string | null = null;
  let current = resolvedWorkspace;
  while (true) {
    if (pathExists(join(current, ".git"))) {
      projectRoot = current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return projectRoot ?? resolvedWorkspace;
    }
    current = parent;
  }
}

function findLocalSkillRoot(workspace: string): LocalSkillRoot {
  const projectRoot = findProjectRoot(workspace);
  let current = resolve(workspace);
  while (true) {
    const rootPath = join(current, LOCAL_SKILL_ROOT);
    if (localSkillRootStatus(rootPath) !== "missing") {
      return { rootPath, displayBasePath: current };
    }
    if (current === projectRoot) {
      return {
        rootPath: join(projectRoot, LOCAL_SKILL_ROOT),
        displayBasePath: projectRoot,
      };
    }
    current = dirname(current);
  }
}

function ensureLocalSkillRootDirectory(root: LocalSkillRoot): boolean {
  const status = localSkillRootStatus(root.rootPath);
  if (status === "missing") {
    return false;
  }
  if (status === "not-directory") {
    throw new WorkflowSkillError(
      `Error: ${LOCAL_SKILL_ROOT} must be a local directory to load workflow skills.`,
    );
  }
  const realBasePath = realpathSync(root.displayBasePath);
  const expectedRootPath = resolve(realBasePath, LOCAL_SKILL_ROOT);
  const realRootPath = realpathSync(root.rootPath);
  if (realRootPath !== expectedRootPath) {
    throw new WorkflowSkillError(
      `Error: ${LOCAL_SKILL_ROOT} must be a local directory to load workflow skills.`,
    );
  }
  return true;
}

function relativeSkillPath(root: LocalSkillRoot, skillName: string): string {
  return toPosixPath(
    relative(root.displayBasePath, join(root.rootPath, skillName, SKILL_FILE)),
  );
}

function skillResourcePath(parts: readonly string[]): string {
  return parts.join("/");
}

function compareSkillResourcePaths(left: string, right: string): number {
  const leftDirectory = left.slice(0, left.indexOf("/"));
  const rightDirectory = right.slice(0, right.indexOf("/"));
  const leftDirectoryIndex =
    WORKFLOW_SKILL_RESOURCE_DIRECTORIES.indexOf(leftDirectory);
  const rightDirectoryIndex =
    WORKFLOW_SKILL_RESOURCE_DIRECTORIES.indexOf(rightDirectory);
  const directoryDelta = leftDirectoryIndex - rightDirectoryIndex;
  if (directoryDelta !== 0) {
    return directoryDelta;
  }
  return left.localeCompare(right);
}

function validateSkillName(name: string): void {
  const result = skillNameSchema.safeParse(name);
  if (!result.success) {
    throw new WorkflowSkillError(`Error: ${result.error.issues[0]?.message}.`);
  }
}

function listSkillResourceDirectory(options: {
  readonly currentPath: string;
  readonly relativeParts: readonly string[];
  readonly state: {
    readonly resourcePaths: string[];
    entryVisits: number;
  };
}): void {
  const directory = opendirSync(options.currentPath);
  try {
    for (;;) {
      if (
        options.state.resourcePaths.length >=
          MAX_WORKFLOW_SKILL_RESOURCE_PATHS ||
        options.state.entryVisits >= MAX_WORKFLOW_SKILL_RESOURCE_ENTRY_VISITS
      ) {
        return;
      }
      const entry = directory.readSync();
      if (entry === null) {
        return;
      }
      options.state.entryVisits += 1;
      const entryPath = join(options.currentPath, entry.name);
      const entryRelativeParts = [...options.relativeParts, entry.name];
      if (entry.isDirectory()) {
        listSkillResourceDirectory({
          currentPath: entryPath,
          relativeParts: entryRelativeParts,
          state: options.state,
        });
        continue;
      }
      if (entry.isFile()) {
        const resourcePath = skillResourcePath(entryRelativeParts);
        if (isWorkflowSkillResourcePath(resourcePath)) {
          options.state.resourcePaths.push(resourcePath);
        }
      }
    }
  } finally {
    directory.closeSync();
  }
}

function listSkillResourcePaths(
  root: LocalSkillRoot,
  skillName: string,
): readonly string[] {
  const skillDirectory = join(root.rootPath, skillName);
  const state: { resourcePaths: string[]; entryVisits: number } = {
    resourcePaths: [],
    entryVisits: 0,
  };
  for (const directory of WORKFLOW_SKILL_RESOURCE_DIRECTORIES) {
    if (
      state.resourcePaths.length >= MAX_WORKFLOW_SKILL_RESOURCE_PATHS ||
      state.entryVisits >= MAX_WORKFLOW_SKILL_RESOURCE_ENTRY_VISITS
    ) {
      return state.resourcePaths.toSorted(compareSkillResourcePaths);
    }
    const directoryPath = join(skillDirectory, directory);
    const stat = lstatSync(directoryPath, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      continue;
    }
    listSkillResourceDirectory({
      currentPath: directoryPath,
      relativeParts: [directory],
      state,
    });
  }
  return state.resourcePaths.toSorted(compareSkillResourcePaths);
}

function ensureRealPathInsideRoot(
  rootPath: string,
  skillFilePath: string,
): void {
  const realRoot = realpathSync(rootPath);
  const realSkillFile = realpathSync(skillFilePath);
  const relativeRealPath = relative(realRoot, realSkillFile);
  if (relativeRealPath.startsWith("..") || isAbsolute(relativeRealPath)) {
    throw new WorkflowSkillError(
      "Error: cannot load workflow skill: resolved SKILL.md path escapes .agents/skills.",
    );
  }
}

function readSkillBytes(skillFilePath: string): Buffer {
  const fd = openSync(skillFilePath, "r");
  try {
    const reportedSize = fstatSync(fd).size;
    if (reportedSize > MAX_WORKFLOW_SKILL_BYTES) {
      throw new WorkflowSkillError(
        `Error: workflow skill SKILL.md is too large to load (${reportedSize} bytes; limit ${MAX_WORKFLOW_SKILL_BYTES} bytes).`,
      );
    }
    const bytes = Buffer.allocUnsafe(reportedSize);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function decodeSkillBytes(skillFilePath: string, bytes: Uint8Array): string {
  const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES);
  if (isBinarySample(skillFilePath, sample) || hasBinaryControlBytes(bytes)) {
    throw new WorkflowSkillError(
      "Error: workflow skill SKILL.md is binary or not valid UTF-8 text.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd();
  } catch {
    throw new WorkflowSkillError(
      "Error: workflow skill SKILL.md is binary or not valid UTF-8 text.",
    );
  }
}

function unquoteFrontmatterValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatterBlock(skillFilePath: string, text: string) {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} must start with YAML frontmatter.`,
    );
  }
  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line === "---",
  );
  if (endIndex === -1) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} has unterminated YAML frontmatter.`,
    );
  }

  const entries: readonly (readonly [string, string])[] = lines
    .slice(1, endIndex)
    .flatMap((line): readonly (readonly [string, string])[] => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        return [];
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = unquoteFrontmatterValue(line.slice(separatorIndex + 1));
      return [[key, value]];
    });
  const parsed = skillFrontmatterSchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} must declare non-empty name and description frontmatter.`,
    );
  }

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    content: lines
      .slice(endIndex + 1)
      .join("\n")
      .trimEnd(),
  };
}

function readWorkflowSkillFile(
  root: LocalSkillRoot,
  skillName: string,
  options: { readonly includeResourcePaths: boolean },
): WorkflowSkill & { readonly description: string } {
  validateSkillName(skillName);
  const skillFilePath = join(root.rootPath, skillName, SKILL_FILE);
  if (!existsSync(skillFilePath)) {
    throw new WorkflowSkillError(
      `Error: workflow skill "${skillName}" was not found in ${LOCAL_SKILL_ROOT}.`,
    );
  }
  ensureRealPathInsideRoot(root.rootPath, skillFilePath);
  const fileStat = statSync(skillFilePath);
  if (!fileStat.isFile()) {
    throw new WorkflowSkillError(
      `Error: workflow skill "${skillName}" must be a regular SKILL.md file.`,
    );
  }
  const bytes = readSkillBytes(skillFilePath);
  const parsed = parseFrontmatterBlock(
    toPosixPath(skillFilePath),
    decodeSkillBytes(skillFilePath, bytes),
  );
  if (parsed.name !== skillName) {
    throw new WorkflowSkillError(
      `Error: workflow skill "${skillName}" has mismatched frontmatter name "${parsed.name}".`,
    );
  }
  return {
    name: parsed.name,
    description: parsed.description,
    relativePath: relativeSkillPath(root, skillName),
    resourcePaths: options.includeResourcePaths
      ? listSkillResourcePaths(root, skillName)
      : [],
    content: parsed.content,
  };
}

export function loadWorkflowSkill(
  workspace: string,
  skillName: string,
): WorkflowSkill {
  validateSkillName(skillName);
  const root = findLocalSkillRoot(workspace);
  if (!ensureLocalSkillRootDirectory(root)) {
    throw new WorkflowSkillError(
      `Error: workflow skill "${skillName}" was not found in ${LOCAL_SKILL_ROOT}.`,
    );
  }
  return readWorkflowSkillFile(root, skillName, { includeResourcePaths: true });
}

export function listWorkflowSkills(workspace: string): WorkflowSkillListResult {
  const root = findLocalSkillRoot(workspace);
  if (!ensureLocalSkillRootDirectory(root)) {
    return { skills: [], warnings: [] };
  }

  const skills: WorkflowSkillSummary[] = [];
  const warnings: WorkflowSkillListWarning[] = [];
  for (const entry of readdirSync(root.rootPath, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !existsSync(join(root.rootPath, entry.name, SKILL_FILE))
    ) {
      continue;
    }
    try {
      const skill = readWorkflowSkillFile(root, entry.name, {
        includeResourcePaths: false,
      });
      skills.push({
        name: skill.name,
        description: skill.description,
        relativePath: skill.relativePath,
      });
    } catch (error) {
      /* v8 ignore next 3: unexpected filesystem failures should still escape listing. */
      if (!(error instanceof WorkflowSkillError)) {
        throw error;
      }
      warnings.push({ name: entry.name, message: error.message });
    }
  }

  return {
    skills: skills.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    ),
    warnings,
  };
}

export function formatWorkflowSkillList(
  skills: readonly WorkflowSkillSummary[],
): string {
  if (skills.length === 0) {
    return `No local workflow skills found in ${LOCAL_SKILL_ROOT}.\n`;
  }
  return [
    "Local workflow skills:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    "",
  ].join("\n");
}

function formatWorkflowSkillWarningMessage(message: string): string {
  return message.replace(/^Error: /u, "");
}

export function formatWorkflowSkillListWarnings(
  warnings: readonly WorkflowSkillListWarning[],
): string {
  return warnings
    .map(
      (warning) =>
        `Warning: skipped workflow skill ${JSON.stringify(warning.name)}: ${formatWorkflowSkillWarningMessage(warning.message)}\n`,
    )
    .join("");
}
