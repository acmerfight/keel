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
  SkillActivationCapability,
  SkillCatalog,
  SkillCatalogWarning,
  SkillDescriptor,
  SkillScope,
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
const QUALIFIED_SKILL_PATTERN = /^(repo|user|system|extra):(.+)$/u;

interface SkillRoot {
  readonly scope: SkillScope;
  readonly rootPath: string;
  readonly displayRoot: string;
  readonly displayBasePath?: string;
  readonly priority: number;
}

interface ReadSkill {
  readonly descriptor: SkillDescriptor;
  readonly skill: WorkflowSkill;
}

export interface SkillDiscoveryOptions {
  readonly workspace: string;
  readonly userRoot?: string;
  readonly systemRoots?: readonly string[];
  readonly extraRoots?: readonly string[];
}

type SkillRootStatus = "missing" | "directory" | "not-directory";

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function skillRootStatus(path: string): SkillRootStatus {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return "missing";
  return stat.isDirectory() ? "directory" : "not-directory";
}

function findProjectRoot(workspace: string): string {
  const resolvedWorkspace = resolve(workspace);
  let projectRoot: string | null = null;
  let current = resolvedWorkspace;
  while (true) {
    if (pathExists(join(current, ".git"))) projectRoot = current;
    const parent = dirname(current);
    if (parent === current) return projectRoot ?? resolvedWorkspace;
    current = parent;
  }
}

function repositorySkillRoots(workspace: string): readonly SkillRoot[] {
  const projectRoot = findProjectRoot(workspace);
  const roots: SkillRoot[] = [];
  let current = resolve(workspace);
  let priority = 0;
  while (true) {
    const rootPath = join(current, LOCAL_SKILL_ROOT);
    if (skillRootStatus(rootPath) !== "missing") {
      roots.push({
        scope: "repo",
        rootPath,
        displayRoot: toPosixPath(relative(workspace, rootPath)),
        displayBasePath: current,
        priority,
      });
    }
    if (current === projectRoot) return roots;
    current = dirname(current);
    priority += 1;
  }
}

function configuredSkillRoot(
  scope: Exclude<SkillScope, "repo">,
  rootPath: string,
  priority: number,
  displayRoot = toPosixPath(resolve(rootPath)),
): SkillRoot {
  return { scope, rootPath: resolve(rootPath), displayRoot, priority };
}

function discoveryRoots(options: SkillDiscoveryOptions): readonly SkillRoot[] {
  return [
    ...repositorySkillRoots(options.workspace),
    ...(options.userRoot === undefined
      ? []
      : [
          configuredSkillRoot(
            "user",
            options.userRoot,
            1_000,
            "~/.agents/skills",
          ),
        ]),
    ...(options.systemRoots ?? []).map((root, index) =>
      configuredSkillRoot("system", root, 2_000 + index),
    ),
    ...(options.extraRoots ?? []).map((root, index) =>
      configuredSkillRoot("extra", root, 3_000 + index),
    ),
  ];
}

function ensureSkillRootDirectory(root: SkillRoot): boolean {
  const status = skillRootStatus(root.rootPath);
  if (status === "missing") return false;
  if (status === "not-directory") {
    throw new WorkflowSkillError(
      `Error: ${root.displayRoot} must be a local directory to load workflow skills.`,
    );
  }
  const expectedRootPath =
    root.displayBasePath === undefined
      ? realpathSync(root.rootPath)
      : resolve(realpathSync(root.displayBasePath), LOCAL_SKILL_ROOT);
  if (realpathSync(root.rootPath) !== expectedRootPath) {
    throw new WorkflowSkillError(
      `Error: ${root.displayRoot} must be a local directory to load workflow skills.`,
    );
  }
  return true;
}

function skillDisplayPath(root: SkillRoot, skillName: string): string {
  if (root.displayBasePath !== undefined) {
    return toPosixPath(
      relative(
        root.displayBasePath,
        join(root.rootPath, skillName, SKILL_FILE),
      ),
    );
  }
  return toPosixPath(join(root.displayRoot, skillName, SKILL_FILE));
}

function compareSkillResourcePaths(left: string, right: string): number {
  const leftDirectory = left.slice(0, left.indexOf("/"));
  const rightDirectory = right.slice(0, right.indexOf("/"));
  const directoryDelta =
    WORKFLOW_SKILL_RESOURCE_DIRECTORIES.indexOf(leftDirectory) -
    WORKFLOW_SKILL_RESOURCE_DIRECTORIES.indexOf(rightDirectory);
  return directoryDelta === 0 ? left.localeCompare(right) : directoryDelta;
}

function listSkillResourceDirectory(options: {
  readonly currentPath: string;
  readonly relativeParts: readonly string[];
  readonly state: { readonly resourcePaths: string[]; entryVisits: number };
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
      if (entry === null) return;
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
  root: SkillRoot,
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
    if (lstatSync(directoryPath, { throwIfNoEntry: false })?.isDirectory()) {
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
  const relativeRealPath = relative(
    realpathSync(rootPath),
    realpathSync(skillFilePath),
  );
  if (relativeRealPath.startsWith("..") || isAbsolute(relativeRealPath)) {
    throw new WorkflowSkillError(
      "Error: cannot load workflow skill: resolved SKILL.md path escapes its skill root.",
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

function skillRootKey(root: SkillRoot): string {
  return createHash("sha256")
    .update(realpathSync(root.rootPath))
    .digest("hex")
    .slice(0, 12);
}

function readSkillFile(
  root: SkillRoot,
  skillName: string,
  includeResourcePaths: boolean,
): ReadSkill {
  validateSkillName(skillName);
  const skillFilePath = join(root.rootPath, skillName, SKILL_FILE);
  if (!existsSync(skillFilePath)) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(`${root.scope}:${skillName}`)} was not found.`,
    );
  }
  ensureRealPathInsideRoot(root.rootPath, skillFilePath);
  if (!statSync(skillFilePath).isFile()) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(`${root.scope}:${skillName}`)} must be a regular SKILL.md file.`,
    );
  }
  const bytes = readSkillBytes(skillFilePath);
  const parsed = parseSkillDocument(
    toPosixPath(skillFilePath),
    decodeSkillBytes(skillFilePath, bytes),
  );
  if (parsed.name !== skillName) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(`${root.scope}:${skillName}`)} has mismatched frontmatter name ${JSON.stringify(parsed.name)}.`,
    );
  }
  const digest = skillDigest(bytes);
  const rootKey = skillRootKey(root);
  const packageId = `${root.scope}:${rootKey}:${parsed.name}`;
  const id = `${packageId}:${digest}`;
  const qualifiedName = `${root.scope}:${parsed.name}`;
  const relativePath = skillDisplayPath(root, skillName);
  return {
    descriptor: {
      id,
      packageId,
      rootKey,
      rootPriority: root.priority,
      qualifiedName,
      scope: root.scope,
      activationPolicy: parsed.activationPolicy,
      name: parsed.name,
      description: parsed.description,
      relativePath,
      digest,
    },
    skill: {
      id,
      packageId,
      qualifiedName,
      scope: root.scope,
      digest,
      name: parsed.name,
      relativePath,
      resourcePaths: includeResourcePaths
        ? listSkillResourcePaths(root, skillName)
        : [],
      content: parsed.content,
    },
  };
}

function lookupParts(lookup: string): {
  readonly scope?: SkillScope;
  readonly name: string;
} {
  const qualified = QUALIFIED_SKILL_PATTERN.exec(lookup);
  if (qualified === null) {
    validateSkillName(lookup);
    return { name: lookup };
  }
  const scope = qualified[1];
  /* v8 ignore next -- QUALIFIED_SKILL_PATTERN restricts the captured scope. */
  if (
    scope !== "repo" &&
    scope !== "user" &&
    scope !== "system" &&
    scope !== "extra"
  ) {
    throw new WorkflowSkillError("Error: qualified skill scope is invalid.");
  }
  const qualifiedRemainder = qualified[2];
  /* v8 ignore next 3 -- QUALIFIED_SKILL_PATTERN requires a non-empty remainder. */
  if (qualifiedRemainder === undefined) {
    throw new WorkflowSkillError("Error: qualified skill name is incomplete.");
  }
  const segments = qualifiedRemainder.split(":");
  if (segments.length > 2) {
    throw new WorkflowSkillError(
      "Error: qualified skill names use scope:name or scope:root-id:name.",
    );
  }
  const name = segments.at(-1);
  /* v8 ignore next 3 -- splitting a defined string always yields one segment. */
  if (name === undefined) {
    throw new WorkflowSkillError("Error: qualified skill name is incomplete.");
  }
  validateSkillName(name);
  return { scope, name };
}

function matchingDescriptors(
  skills: readonly SkillDescriptor[],
  lookup: string,
): readonly SkillDescriptor[] {
  const parts = lookupParts(lookup);
  if (parts.scope !== undefined && lookup.split(":").length === 3) {
    return skills.filter((skill) => skill.qualifiedName === lookup);
  }
  return skills.filter(
    (skill) =>
      skill.name === parts.name &&
      (parts.scope === undefined || skill.scope === parts.scope),
  );
}

function resolveDescriptor(
  skills: readonly SkillDescriptor[],
  lookup: string,
): SkillDescriptor {
  const matches = matchingDescriptors(skills, lookup);
  if (matches.length === 0) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(lookup)} was not found.`,
    );
  }
  if (matches.length > 1) {
    const choices = matches
      .map(
        (skill) =>
          `${JSON.stringify(skill.qualifiedName)} (${skill.relativePath})`,
      )
      .join(", ");
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(lookup)} is ambiguous; choose one of: ${choices}.`,
    );
  }
  const descriptor = matches[0];
  /* v8 ignore next 3 -- the zero-match case returns above. */
  if (descriptor === undefined) {
    throw new WorkflowSkillError("Error: resolved workflow skill disappeared.");
  }
  return descriptor;
}

function searchScore(skill: SkillDescriptor, query: string): number {
  if (query === "") return 1;
  const normalized = query.toLowerCase();
  const terms = normalized.split(/\s+/u).filter((term) => term !== "");
  const name = skill.name.toLowerCase();
  const qualifiedName = skill.qualifiedName.toLowerCase();
  const description = skill.description.toLowerCase();
  let score = name === normalized || qualifiedName === normalized ? 1_000 : 0;
  for (const term of terms) {
    if (name === term) score += 200;
    else if (name.includes(term)) score += 80;
    if (qualifiedName.includes(term)) score += 30;
    if (description.includes(term)) score += 20;
  }
  return score;
}

export function discoverSkillCatalog(
  options: SkillDiscoveryOptions,
): SkillCatalog {
  const rootsById = new Map<string, SkillRoot>();
  const seenRoots = new Set<string>();
  const skills: SkillDescriptor[] = [];
  const warnings: SkillCatalogWarning[] = [];
  for (const root of discoveryRoots(options)) {
    if (!ensureSkillRootDirectory(root)) continue;
    const rootIdentity = `${root.scope}:${realpathSync(root.rootPath)}`;
    if (seenRoots.has(rootIdentity)) continue;
    seenRoots.add(rootIdentity);
    for (const entry of readdirSync(root.rootPath, { withFileTypes: true })) {
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        !existsSync(join(root.rootPath, entry.name, SKILL_FILE))
      ) {
        continue;
      }
      try {
        const read = readSkillFile(root, entry.name, false);
        skills.push(read.descriptor);
        rootsById.set(read.descriptor.id, root);
      } catch (error) {
        /* v8 ignore next 3: unexpected filesystem/runtime faults must propagate. */
        if (!(error instanceof WorkflowSkillError)) throw error;
        warnings.push({
          name: `${root.scope}:${entry.name}`,
          message: error.message,
        });
      }
    }
  }
  const duplicateCounts = new Map<string, number>();
  for (const skill of skills) {
    const key = `${skill.scope}:${skill.name}`;
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }
  const collisionSafeSkills = skills.map((skill) => ({
    ...skill,
    qualifiedName:
      duplicateCounts.get(`${skill.scope}:${skill.name}`) === 1
        ? `${skill.scope}:${skill.name}`
        : `${skill.scope}:${skill.rootKey}:${skill.name}`,
  }));
  const sortedSkills = collisionSafeSkills.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.scope.localeCompare(right.scope) ||
      left.relativePath.localeCompare(right.relativePath),
  );
  const loadFrom = (
    candidates: readonly SkillDescriptor[],
    lookup: string,
  ): WorkflowSkill => {
    const descriptor = resolveDescriptor(candidates, lookup);
    const root = rootsById.get(descriptor.id);
    /* v8 ignore next 4 -- descriptors and roots are populated atomically above. */
    if (root === undefined) {
      throw new WorkflowSkillError(
        `Error: workflow skill ${JSON.stringify(lookup)} is no longer available.`,
      );
    }
    const current = readSkillFile(root, descriptor.name, true);
    if (
      current.descriptor.digest !== descriptor.digest ||
      current.descriptor.id !== descriptor.id
    ) {
      throw new WorkflowSkillError(
        `Error: workflow skill ${JSON.stringify(descriptor.qualifiedName)} changed after catalog discovery.`,
      );
    }
    return { ...current.skill, qualifiedName: descriptor.qualifiedName };
  };
  const implicitSkills = sortedSkills.filter(
    (skill) => skill.activationPolicy === "implicit",
  );
  const warningForLookup = (
    lookup: string,
  ): SkillCatalogWarning | undefined => {
    const parts = lookupParts(lookup);
    const matches = warnings.filter((warning) => {
      const separator = warning.name.indexOf(":");
      const scope = warning.name.slice(0, separator);
      const name = warning.name.slice(separator + 1);
      return (
        name === parts.name &&
        (parts.scope === undefined || scope === parts.scope)
      );
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
  const loadWithWarning = (
    candidates: readonly SkillDescriptor[],
    lookup: string,
  ): WorkflowSkill => {
    try {
      return loadFrom(candidates, lookup);
    } catch (error) {
      if (
        error instanceof WorkflowSkillError &&
        error.message.endsWith("was not found.")
      ) {
        const warning = warningForLookup(lookup);
        if (warning !== undefined)
          throw new WorkflowSkillError(warning.message);
      }
      throw error;
    }
  };
  return {
    skills: sortedSkills,
    implicitSkills,
    warnings,
    load: (lookup) => loadWithWarning(sortedSkills, lookup),
    loadImplicit: (lookup) => loadWithWarning(implicitSkills, lookup),
    search: (query, limit = 20) =>
      implicitSkills
        .map((skill) => ({ skill, score: searchScore(skill, query.trim()) }))
        .filter((result) => result.score > 0)
        .toSorted(
          (left, right) =>
            right.score - left.score ||
            left.skill.qualifiedName.localeCompare(right.skill.qualifiedName),
        )
        .slice(0, Math.max(0, limit))
        .map((result) => result.skill),
    readResource: (lookup, path) => {
      if (!isWorkflowSkillResourcePath(path)) {
        throw new WorkflowSkillError(
          "Error: skill resource paths must stay under references/, scripts/, or assets/.",
        );
      }
      const descriptor = resolveDescriptor(sortedSkills, lookup);
      const root = rootsById.get(descriptor.id);
      /* v8 ignore next 4 -- descriptors and roots are populated atomically above. */
      if (root === undefined) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(lookup)} is no longer available.`,
        );
      }
      const current = readSkillFile(root, descriptor.name, true);
      if (current.descriptor.digest !== descriptor.digest) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(descriptor.qualifiedName)} changed after catalog discovery.`,
        );
      }
      if (!current.skill.resourcePaths.includes(path)) {
        throw new WorkflowSkillError(
          `Error: resource ${JSON.stringify(path)} was not discovered for workflow skill ${JSON.stringify(descriptor.qualifiedName)}.`,
        );
      }
      const resourcePath = join(root.rootPath, descriptor.name, path);
      ensureRealPathInsideRoot(
        join(root.rootPath, descriptor.name),
        resourcePath,
      );
      return decodeSkillBytes(resourcePath, readSkillBytes(resourcePath));
    },
  };
}

export function createSkillActivation(
  catalog: SkillCatalog,
): SkillActivationCapability {
  let activatedName: string | null = null;
  const selectableIds = new Set<string>();
  const activeIds = new Set<string>();
  const activePackageIds = new Set<string>();
  return {
    expose: (skills) => {
      for (const skill of skills) selectableIds.add(skill.id);
    },
    registerExplicit: (skills) => {
      for (const skill of skills) {
        activeIds.add(skill.id);
        activePackageIds.add(skill.packageId);
      }
    },
    search: (query) => {
      const matches = catalog.search(query);
      for (const skill of matches) selectableIds.add(skill.id);
      return matches;
    },
    readResource: (lookup, path) => {
      const skill = catalog.load(lookup);
      if (!activeIds.has(skill.id)) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(skill.qualifiedName)} must be active before reading its resources.`,
        );
      }
      return catalog.readResource(skill.qualifiedName, path);
    },
    activate: (name) => {
      if (activatedName !== null) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(activatedName)} is already active; this run supports one model-selected skill.`,
        );
      }
      const skill = catalog.loadImplicit(name);
      if (activePackageIds.has(skill.packageId)) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(skill.qualifiedName)} is already active; do not activate the same package twice.`,
        );
      }
      if (!selectableIds.has(skill.id)) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(skill.qualifiedName)} is not in the exposed catalog or recent search results; search for it before activation.`,
        );
      }
      activatedName = skill.qualifiedName;
      activeIds.add(skill.id);
      activePackageIds.add(skill.packageId);
      return {
        skill,
        record: {
          name: skill.qualifiedName,
          relativePath: skill.relativePath,
          trigger: "model_selected",
        },
      };
    },
  };
}
