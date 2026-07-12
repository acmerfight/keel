import { createHash } from "node:crypto";
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
import {
  BINARY_SAMPLE_BYTES,
  hasBinaryControlBytes,
  isBinarySample,
} from "../tools/text-file.ts";
import type {
  ProjectSkillCatalog,
  SkillActivationCapability,
  SkillCatalogWarning,
  SkillDescriptor,
  WorkflowSkill,
} from "./model.ts";
import { WorkflowSkillError } from "./model.ts";
import {
  isWorkflowSkillResourcePath,
  MAX_WORKFLOW_SKILL_RESOURCE_ENTRY_VISITS,
  MAX_WORKFLOW_SKILL_RESOURCE_PATHS,
  WORKFLOW_SKILL_RESOURCE_DIRECTORIES,
} from "./resources.ts";
import { parseSkillDocument, validateSkillName } from "./schema.ts";

const LOCAL_SKILL_ROOT = join(".agents", "skills");
const SKILL_FILE = "SKILL.md";
const MAX_WORKFLOW_SKILL_BYTES = 50 * 1024;

interface LocalSkillRoot {
  readonly rootPath: string;
  readonly displayBasePath: string;
}

interface ReadProjectSkill {
  readonly descriptor: SkillDescriptor;
  readonly skill: WorkflowSkill;
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

function compareSkillResourcePaths(left: string, right: string): number {
  const leftDirectory = left.slice(0, left.indexOf("/"));
  const rightDirectory = right.slice(0, right.indexOf("/"));
  const leftDirectoryIndex =
    WORKFLOW_SKILL_RESOURCE_DIRECTORIES.indexOf(leftDirectory);
  const rightDirectoryIndex =
    WORKFLOW_SKILL_RESOURCE_DIRECTORIES.indexOf(rightDirectory);
  const directoryDelta = leftDirectoryIndex - rightDirectoryIndex;
  return directoryDelta === 0 ? left.localeCompare(right) : directoryDelta;
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
      } else if (entry.isFile()) {
        const resourcePath = entryRelativeParts.join("/");
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
      break;
    }
    const directoryPath = join(skillDirectory, directory);
    const stat = lstatSync(directoryPath, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true) {
      listSkillResourceDirectory({
        currentPath: directoryPath,
        relativeParts: [directory],
        state,
      });
    }
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

function skillDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readProjectSkillFile(
  root: LocalSkillRoot,
  skillName: string,
  includeResourcePaths: boolean,
): ReadProjectSkill {
  validateSkillName(skillName);
  const skillFilePath = join(root.rootPath, skillName, SKILL_FILE);
  if (!existsSync(skillFilePath)) {
    throw new WorkflowSkillError(
      `Error: workflow skill "${skillName}" was not found in ${LOCAL_SKILL_ROOT}.`,
    );
  }
  ensureRealPathInsideRoot(root.rootPath, skillFilePath);
  if (!statSync(skillFilePath).isFile()) {
    throw new WorkflowSkillError(
      `Error: workflow skill "${skillName}" must be a regular SKILL.md file.`,
    );
  }
  const bytes = readSkillBytes(skillFilePath);
  const parsed = parseSkillDocument(
    toPosixPath(skillFilePath),
    decodeSkillBytes(skillFilePath, bytes),
  );
  if (parsed.name !== skillName) {
    throw new WorkflowSkillError(
      `Error: workflow skill "${skillName}" has mismatched frontmatter name "${parsed.name}".`,
    );
  }
  const relativePath = relativeSkillPath(root, skillName);
  return {
    descriptor: {
      name: parsed.name,
      description: parsed.description,
      relativePath,
      digest: skillDigest(bytes),
    },
    skill: {
      name: parsed.name,
      relativePath,
      resourcePaths: includeResourcePaths
        ? listSkillResourcePaths(root, skillName)
        : [],
      content: parsed.content,
    },
  };
}

export function loadProjectWorkflowSkill(
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
  return readProjectSkillFile(root, skillName, true).skill;
}

export function discoverProjectSkillCatalog(
  workspace: string,
): ProjectSkillCatalog {
  const root = findLocalSkillRoot(workspace);
  if (!ensureLocalSkillRootDirectory(root)) {
    return {
      skills: [],
      warnings: [],
      load: (name) => {
        throw new WorkflowSkillError(
          `Error: workflow skill "${name}" was not found in ${LOCAL_SKILL_ROOT}.`,
        );
      },
    };
  }

  const skills: SkillDescriptor[] = [];
  const warnings: SkillCatalogWarning[] = [];
  for (const entry of readdirSync(root.rootPath, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !existsSync(join(root.rootPath, entry.name, SKILL_FILE))
    ) {
      continue;
    }
    try {
      skills.push(readProjectSkillFile(root, entry.name, false).descriptor);
    } catch (error) {
      /* v8 ignore next 3: unexpected filesystem/runtime faults must propagate rather than become invalid-skill warnings. */
      if (!(error instanceof WorkflowSkillError)) {
        throw error;
      }
      warnings.push({ name: entry.name, message: error.message });
    }
  }
  const sortedSkills = skills.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const descriptorByName = new Map(
    sortedSkills.map((descriptor) => [descriptor.name, descriptor]),
  );
  return {
    skills: sortedSkills,
    warnings,
    load: (name) => {
      validateSkillName(name);
      const descriptor = descriptorByName.get(name);
      if (descriptor === undefined) {
        throw new WorkflowSkillError(
          `Error: workflow skill "${name}" was not found in ${LOCAL_SKILL_ROOT}.`,
        );
      }
      const current = readProjectSkillFile(root, name, true);
      if (current.descriptor.digest !== descriptor.digest) {
        throw new WorkflowSkillError(
          `Error: workflow skill "${name}" changed after catalog discovery.`,
        );
      }
      return current.skill;
    },
  };
}

export function createProjectSkillActivation(
  catalog: ProjectSkillCatalog,
): SkillActivationCapability {
  let activatedName: string | null = null;
  return {
    activate: (name) => {
      if (activatedName !== null) {
        throw new WorkflowSkillError(
          `Error: workflow skill "${activatedName}" is already active; this run supports one model-selected skill.`,
        );
      }
      const skill = catalog.load(name);
      activatedName = name;
      return {
        skill,
        record: {
          name: skill.name,
          relativePath: skill.relativePath,
          trigger: "model_selected",
        },
      };
    },
  };
}
