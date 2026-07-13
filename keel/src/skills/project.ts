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
import { redactSecretLikeText } from "../core/secret-text.ts";
import {
  BINARY_SAMPLE_BYTES,
  hasBinaryControlBytes,
  isBinaryContentSample,
  isBinarySample,
} from "../tools/text-file.ts";
import {
  auditSkillPackage,
  firstSkillAuditBlocker,
  type SkillAuditFinding,
  type SkillPackageAudit,
} from "./audit.ts";
import type {
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
  MAX_WORKFLOW_SKILL_TEXT_RESOURCE_BYTES,
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
  readonly findings: readonly SkillAuditFinding[];
}

interface SkillResourceInventory {
  readonly resourcePaths: readonly string[];
  readonly findings: readonly SkillAuditFinding[];
}

interface DiscoveredSkillAudit {
  readonly scope: SkillScope;
  readonly name: string;
  readonly rootKey: string;
  readonly relativePath: string;
  readonly findings: readonly SkillAuditFinding[];
}

class SkillPackageValidationError extends WorkflowSkillError {
  readonly auditMessage: string;

  constructor(message: string, auditMessage: string) {
    super(message);
    this.name = "SkillPackageValidationError";
    this.auditMessage = auditMessage;
  }
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
  readonly state: {
    readonly resourcePaths: string[];
    readonly findings: SkillAuditFinding[];
    entryVisits: number;
  };
}): void {
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(options.currentPath);
  } catch {
    options.state.findings.push({
      severity: "blocker",
      code: "resource_unreadable",
      relativePath: options.relativeParts.join("/"),
      message: "could not be opened during deterministic package audit",
    });
    return;
  }
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return;
      if (
        options.state.resourcePaths.length >=
          MAX_WORKFLOW_SKILL_RESOURCE_PATHS ||
        options.state.entryVisits >= MAX_WORKFLOW_SKILL_RESOURCE_ENTRY_VISITS
      ) {
        if (
          !options.state.findings.some(
            (finding) => finding.code === "resource_scan_incomplete",
          )
        ) {
          options.state.findings.push({
            severity: "blocker",
            code: "resource_scan_incomplete",
            relativePath: options.relativeParts.join("/"),
            message:
              "exceeds the bounded package inventory, so deterministic audit could not inspect every resource",
          });
        }
        return;
      }
      options.state.entryVisits += 1;
      const entryPath = join(options.currentPath, entry.name);
      const entryRelativeParts = [...options.relativeParts, entry.name];
      const resourcePath = entryRelativeParts.join("/");
      if (!isWorkflowSkillResourcePath(resourcePath)) {
        options.state.findings.push({
          severity: "blocker",
          code: "invalid_resource_path",
          relativePath: resourcePath,
          message:
            "contains path separators, traversal, control, bidi, or zero-width characters",
        });
        continue;
      }
      if (entry.isSymbolicLink()) {
        options.state.findings.push({
          severity: "blocker",
          code: "resource_symlink",
          relativePath: entryRelativeParts.join("/"),
          message:
            "is a symbolic link; package resources must remain regular files and directories",
        });
      } else if (entry.isDirectory()) {
        listSkillResourceDirectory({
          currentPath: entryPath,
          relativeParts: entryRelativeParts,
          state: options.state,
        });
      } else {
        /* v8 ignore else -- portable Skill fixtures can create files, directories, and symlinks; device/socket entries remain fail-closed. */
        if (entry.isFile()) {
          options.state.resourcePaths.push(resourcePath);
        } else {
          options.state.findings.push({
            severity: "blocker",
            code: "resource_unreadable",
            relativePath: entryRelativeParts.join("/"),
            message:
              "is not a regular file or directory and cannot be audited safely",
          });
        }
      }
    }
  } catch {
    /* v8 ignore next 7 -- a directory read can fail only after a successful open because of a concurrent filesystem or mount fault. */
    options.state.findings.push({
      severity: "blocker",
      code: "resource_unreadable",
      relativePath: options.relativeParts.join("/"),
      message:
        "could not be read completely during deterministic package audit",
    });
  } finally {
    directory.closeSync();
  }
}

function listSkillResourcePaths(
  root: SkillRoot,
  skillName: string,
): SkillResourceInventory {
  const skillDirectory = join(root.rootPath, skillName);
  const state: {
    resourcePaths: string[];
    findings: SkillAuditFinding[];
    entryVisits: number;
  } = {
    resourcePaths: [],
    findings: [],
    entryVisits: 0,
  };
  for (const directory of WORKFLOW_SKILL_RESOURCE_DIRECTORIES) {
    const directoryPath = join(skillDirectory, directory);
    const directoryStat = lstatSync(directoryPath, { throwIfNoEntry: false });
    if (directoryStat?.isSymbolicLink()) {
      state.findings.push({
        severity: "blocker",
        code: "resource_symlink",
        relativePath: directory,
        message:
          "is a symbolic link; package resource directories must remain inside the Skill package",
      });
    } else if (directoryStat?.isDirectory()) {
      listSkillResourceDirectory({
        currentPath: directoryPath,
        relativeParts: [directory],
        state,
      });
    } else if (directoryStat !== undefined) {
      state.findings.push({
        severity: "blocker",
        code: "resource_unreadable",
        relativePath: directory,
        message: "must be a directory when present in a Skill package",
      });
    }
  }
  return {
    resourcePaths: state.resourcePaths.toSorted(compareSkillResourcePaths),
    findings: state.findings,
  };
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

function binarySkillResourceError(relativePath: string): WorkflowSkillError {
  /* v8 ignore next 2 -- audit blocks non-assets binaries; the fallback wording only protects a concurrent replacement after re-audit. */
  const kind = relativePath.startsWith("assets/")
    ? "binary asset"
    : "binary resource";
  return new WorkflowSkillError(
    `Error: workflow skill resource ${JSON.stringify(redactSecretLikeText(relativePath))} is a ${kind} and cannot be read as text with skill_resource; use its advertised Skill-relative path with an approved binary-capable tool.`,
  );
}

function readSkillResourceText(
  resourcePath: string,
  relativePath: string,
): string {
  const fd = openSync(resourcePath, "r");
  try {
    const reportedSize = fstatSync(fd).size;
    const sample = Buffer.allocUnsafe(
      Math.min(reportedSize, BINARY_SAMPLE_BYTES),
    );
    const sampleBytesRead = readSync(fd, sample, 0, sample.length, 0);
    if (
      isBinaryContentSample(
        sample.subarray(0, sampleBytesRead),
        sampleBytesRead === reportedSize,
      )
    ) {
      throw binarySkillResourceError(relativePath);
    }
    /* v8 ignore next 4 -- the package is re-audited immediately before this read; only concurrent growth can cross the text limit here. */
    if (reportedSize > MAX_WORKFLOW_SKILL_TEXT_RESOURCE_BYTES) {
      throw new WorkflowSkillError(
        `Error: workflow skill resource ${JSON.stringify(redactSecretLikeText(relativePath))} is too large to read as text (${reportedSize} bytes; limit ${MAX_WORKFLOW_SKILL_TEXT_RESOURCE_BYTES} bytes).`,
      );
    }
    const bytes = Buffer.allocUnsafe(reportedSize);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    const content = bytes.subarray(0, bytesRead);
    /* v8 ignore next 3 -- the package is re-audited immediately before this read; only concurrent replacement can introduce later binary bytes. */
    if (hasBinaryControlBytes(content)) {
      throw binarySkillResourceError(relativePath);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(content)
        .trimEnd();
    } catch {
      /* v8 ignore next 1 -- the package is re-audited immediately before this read; only concurrent replacement can introduce invalid UTF-8. */
      throw binarySkillResourceError(relativePath);
    }
  } finally {
    closeSync(fd);
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

function readSkillFileFromDisk(
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
  const decoded = decodeSkillBytes(skillFilePath, bytes);
  const parsed = parseSkillDocument(toPosixPath(skillFilePath), decoded);
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
  const inventory = listSkillResourcePaths(root, skillName);
  const findings = auditSkillPackage({
    skillDirectory: join(root.rootPath, skillName),
    skillRelativePath: relativePath,
    content: decoded,
    description: parsed.description,
    descriptionSource: parsed.descriptionSource,
    resourcePaths: inventory.resourcePaths,
    inventoryFindings: inventory.findings,
    ...(parsed.allowedTools !== undefined
      ? { allowedTools: parsed.allowedTools }
      : {}),
    ...(parsed.compatibility !== undefined
      ? { compatibility: parsed.compatibility }
      : {}),
  });
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
      resourcePaths: includeResourcePaths ? inventory.resourcePaths : [],
      content: parsed.content,
    },
    findings,
  };
}

function readSkillFile(
  root: SkillRoot,
  skillName: string,
  includeResourcePaths: boolean,
): ReadSkill {
  try {
    return readSkillFileFromDisk(root, skillName, includeResourcePaths);
  } catch (error) {
    if (error instanceof WorkflowSkillError) {
      const auditMessage = invalidPackageAuditMessage(error);
      throw new SkillPackageValidationError(
        invalidPackageErrorMessage(root, skillName, auditMessage),
        auditMessage,
      );
    }
    /* v8 ignore else: filesystem operations throw errno exceptions; unexpected implementation faults must retain their original identity. */
    if (isErrnoException(error)) {
      const auditMessage =
        "Skill package files could not be read during deterministic validation";
      throw new SkillPackageValidationError(
        invalidPackageErrorMessage(root, skillName, auditMessage),
        auditMessage,
      );
    }
    /* v8 ignore next: preserve unexpected implementation faults for the runtime boundary. */
    throw error;
  }
}

function assertSkillAuditPass(
  qualifiedName: string,
  findings: readonly SkillAuditFinding[],
): void {
  const blocker = firstSkillAuditBlocker(findings);
  if (blocker === undefined) return;
  throw new WorkflowSkillError(skillAuditErrorMessage(qualifiedName, blocker));
}

function skillAuditErrorMessage(
  qualifiedName: string,
  blocker: SkillAuditFinding,
): string {
  return `Error: workflow skill ${JSON.stringify(redactSecretLikeText(qualifiedName))} is blocked by deterministic audit [${blocker.code}] at ${redactSecretLikeText(blocker.relativePath)}: ${redactSecretLikeText(blocker.message)}.`;
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

function invalidPackageAuditMessage(error: WorkflowSkillError): string {
  if (error instanceof SkillPackageValidationError) {
    return error.auditMessage;
  }
  const message = error.message;
  if (message.includes("resolved SKILL.md path escapes")) {
    return "SKILL.md resolves outside its declared Skill root";
  }
  if (message.includes("must be a regular SKILL.md")) {
    return "SKILL.md must be a regular file";
  }
  /* v8 ignore next 2 -- discovery checks SKILL.md existence immediately before reading; this only catches a concurrent deletion. */
  if (message.includes("was not found")) {
    return "SKILL.md is missing from the package";
  }
  if (message.includes("SKILL.md is too large")) {
    return `SKILL.md exceeds the ${MAX_WORKFLOW_SKILL_BYTES}-byte limit`;
  }
  if (message.includes("binary or not valid UTF-8")) {
    return "SKILL.md must be valid UTF-8 text without binary control bytes";
  }
  if (message.includes("mismatched frontmatter name")) {
    return "frontmatter name must match the parent package directory";
  }
  if (message.includes("must start with YAML frontmatter")) {
    return "SKILL.md must start with YAML frontmatter";
  }
  if (message.includes("unterminated YAML frontmatter")) {
    return "SKILL.md YAML frontmatter must end with a closing delimiter";
  }
  if (message.includes("invalid YAML frontmatter")) {
    return "SKILL.md contains invalid YAML frontmatter";
  }
  if (message.includes("invalid Agent Skills frontmatter")) {
    return "frontmatter does not match the Agent Skills schema";
  }
  if (message.includes("metadata.keel.activation")) {
    return 'metadata.keel.activation must be "implicit" or "explicit"';
  }
  /* v8 ignore next 3 -- all current package-validation sites are categorized above or use the shared skill-name validator. */
  if (!message.includes("skill names may contain")) {
    return "does not satisfy deterministic package validation";
  }
  return "package name violates the Agent Skills lowercase name contract";
}

function invalidPackageErrorMessage(
  root: SkillRoot,
  skillName: string,
  auditMessage: string,
): string {
  const qualifiedName = redactSecretLikeText(`${root.scope}:${skillName}`);
  const displayPath = redactSecretLikeText(skillDisplayPath(root, skillName));
  return `Error: workflow skill ${JSON.stringify(qualifiedName)} is blocked by deterministic audit [invalid_package] at ${displayPath}: ${redactSecretLikeText(auditMessage)}.`;
}

export function discoverSkillCatalog(
  options: SkillDiscoveryOptions,
): SkillCatalog {
  const rootsById = new Map<string, SkillRoot>();
  const seenRoots = new Set<string>();
  const skills: SkillDescriptor[] = [];
  const discoveredAudits: DiscoveredSkillAudit[] = [];
  const recordInvalidPackage = (
    root: SkillRoot,
    skillName: string,
    auditMessage: string,
  ): void => {
    discoveredAudits.push({
      scope: root.scope,
      name: skillName,
      rootKey: skillRootKey(root),
      relativePath: skillDisplayPath(root, skillName),
      findings: [
        {
          severity: "blocker",
          code: "invalid_package",
          relativePath: skillDisplayPath(root, skillName),
          message: auditMessage,
        },
      ],
    });
  };
  for (const root of discoveryRoots(options)) {
    if (!ensureSkillRootDirectory(root)) continue;
    const rootIdentity = `${root.scope}:${realpathSync(root.rootPath)}`;
    if (seenRoots.has(rootIdentity)) continue;
    seenRoots.add(rootIdentity);
    for (const entry of readdirSync(root.rootPath, { withFileTypes: true })) {
      const skillFileExists = existsSync(
        join(root.rootPath, entry.name, SKILL_FILE),
      );
      if (entry.isSymbolicLink() && !skillFileExists) {
        recordInvalidPackage(
          root,
          entry.name,
          "Skill package symlink is dangling or has no readable SKILL.md",
        );
        continue;
      }
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        !skillFileExists
      ) {
        continue;
      }
      try {
        const read = readSkillFile(root, entry.name, false);
        discoveredAudits.push({
          scope: root.scope,
          name: read.descriptor.name,
          rootKey: read.descriptor.rootKey,
          relativePath: read.descriptor.relativePath,
          findings: read.findings,
        });
        const blocker = firstSkillAuditBlocker(read.findings);
        if (blocker !== undefined) {
          continue;
        }
        skills.push(read.descriptor);
        rootsById.set(read.descriptor.id, root);
      } catch (error) {
        /* v8 ignore next 3: unexpected filesystem/runtime faults must propagate. */
        if (!(error instanceof WorkflowSkillError)) throw error;
        recordInvalidPackage(
          root,
          entry.name,
          invalidPackageAuditMessage(error),
        );
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
  const auditDuplicateCounts = new Map<string, number>();
  for (const audit of discoveredAudits) {
    const key = `${audit.scope}:${audit.name}`;
    auditDuplicateCounts.set(key, (auditDuplicateCounts.get(key) ?? 0) + 1);
  }
  const identifiedAudits = discoveredAudits.map((audit) => ({
    ...audit,
    qualifiedName:
      auditDuplicateCounts.get(`${audit.scope}:${audit.name}`) === 1
        ? `${audit.scope}:${audit.name}`
        : `${audit.scope}:${audit.rootKey}:${audit.name}`,
  }));
  const warnings: readonly SkillCatalogWarning[] = identifiedAudits.flatMap(
    (audit) => {
      const blocker = firstSkillAuditBlocker(audit.findings);
      return blocker === undefined
        ? []
        : [
            {
              name: audit.qualifiedName,
              message: skillAuditErrorMessage(audit.qualifiedName, blocker),
            },
          ];
    },
  );
  const audits: readonly SkillPackageAudit[] = identifiedAudits
    .map((audit) => ({
      qualifiedName: audit.qualifiedName,
      relativePath: audit.relativePath,
      findings: audit.findings,
    }))
    .toSorted((left, right) =>
      left.qualifiedName.localeCompare(right.qualifiedName),
    );
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
    assertSkillAuditPass(descriptor.qualifiedName, current.findings);
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
    if (parts.scope !== undefined && lookup.split(":").length === 3) {
      return warnings.find((warning) => warning.name === lookup);
    }
    const matches = warnings.filter((warning) => {
      const warningParts = warning.name.split(":");
      const scope = warningParts[0];
      const name = warningParts.at(-1);
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
    audits,
    load: (lookup) => loadWithWarning(sortedSkills, lookup),
    loadImplicit: (lookup) => loadWithWarning(implicitSkills, lookup),
    loadPackage: (packageId) => {
      const descriptor = sortedSkills.find(
        (skill) => skill.packageId === packageId,
      );
      if (descriptor === undefined) return undefined;
      const root = rootsById.get(descriptor.id);
      /* v8 ignore next -- descriptors and roots are populated atomically above. */
      if (root === undefined) return undefined;
      const current = readSkillFile(root, descriptor.name, true);
      assertSkillAuditPass(descriptor.qualifiedName, current.findings);
      return { ...current.skill, qualifiedName: descriptor.qualifiedName };
    },
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
      assertSkillAuditPass(descriptor.qualifiedName, current.findings);
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
      return readSkillResourceText(resourcePath, path);
    },
    readPackageResource: (packageId, digest, path) => {
      if (!isWorkflowSkillResourcePath(path)) {
        throw new WorkflowSkillError(
          "Error: skill resource paths must stay under references/, scripts/, or assets/.",
        );
      }
      const descriptor = sortedSkills.find(
        (skill) => skill.packageId === packageId,
      );
      if (descriptor === undefined) {
        throw new WorkflowSkillError(
          `Error: active workflow skill package ${JSON.stringify(packageId)} is no longer available.`,
        );
      }
      const root = rootsById.get(descriptor.id);
      /* v8 ignore next 4 -- descriptors and roots are populated atomically above. */
      if (root === undefined) {
        throw new WorkflowSkillError(
          `Error: active workflow skill package ${JSON.stringify(packageId)} is no longer available.`,
        );
      }
      const current = readSkillFile(root, descriptor.name, true);
      assertSkillAuditPass(descriptor.qualifiedName, current.findings);
      if (current.skill.digest !== digest) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(descriptor.qualifiedName)} changed on disk; reload it before reading resources.`,
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
      return readSkillResourceText(resourcePath, path);
    },
  };
}
