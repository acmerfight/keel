import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { redactSecretLikeText } from "../core/secret-text.ts";
import type { SkillPackageAudit } from "../skills/audit.ts";
import {
  exposeSkillCatalog,
  type SkillCatalogExposure,
} from "../skills/catalog.ts";
import {
  type SkillCatalog,
  type SkillDescriptor,
  type WorkflowSkill,
  WorkflowSkillError,
} from "../skills/model.ts";
import {
  discoverSkillCatalog,
  resolveSkillDescriptor,
  type SkillDiscoveryOptions,
} from "../skills/project.ts";
import { sanitizeStatusLineText } from "./output.ts";
import type { CliRuntime } from "./runtime.ts";
import { readUserSkillConfig } from "./skill-user-config.ts";

export { WorkflowSkillError };

export interface WorkflowSkillSummary {
  readonly qualifiedName: string;
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly activationPolicy: "implicit" | "explicit";
  readonly disabled: boolean;
}

export interface WorkflowSkillListWarning {
  readonly name: string;
  readonly message: string;
}

export interface WorkflowSkillListResult {
  readonly skills: readonly WorkflowSkillSummary[];
  readonly warnings: readonly WorkflowSkillListWarning[];
  readonly audits: readonly SkillPackageAudit[];
  readonly exposure: SkillCatalogExposure;
  readonly globallyEnabled: boolean;
}

function configuredRoots(value: string | undefined): readonly string[] {
  return (
    value
      ?.split(delimiter)
      .map((root) => root.trim())
      .filter((root) => root !== "") ?? []
  );
}

function skillDiscoveryOptions(
  runtime: Pick<CliRuntime, "env">,
  workspace: string,
): SkillDiscoveryOptions {
  const home = runtime.env("HOME") ?? runtime.env("USERPROFILE") ?? homedir();
  const keelHome = runtime.env("KEEL_HOME") ?? join(home, ".keel");
  return {
    workspace,
    userRoot: join(home, ".agents", "skills"),
    systemRoots: [
      join(keelHome, "skills", ".system"),
      ...configuredRoots(runtime.env("KEEL_SYSTEM_SKILL_ROOTS")),
    ],
    extraRoots: configuredRoots(runtime.env("KEEL_EXTRA_SKILL_ROOTS")),
  };
}

export function discoverWorkflowSkillCatalog(
  runtime: Pick<CliRuntime, "env">,
  workspace: string,
): SkillCatalog {
  return discoverSkillCatalog(skillDiscoveryOptions(runtime, workspace));
}

function disabledSkillMessage(qualifiedName: string): string {
  return `Error: workflow skill ${JSON.stringify(qualifiedName)} is disabled by user configuration; run keel skills enable ${qualifiedName} to enable it.`;
}

export function filterWorkflowSkillCatalog(
  catalog: SkillCatalog,
  disabledPackageIds: readonly string[],
): SkillCatalog {
  if (disabledPackageIds.length === 0) return catalog;
  const disabled = new Set(disabledPackageIds);
  const enabledSkills = catalog.skills.filter(
    (skill) => !disabled.has(skill.packageId),
  );
  const enabledImplicitSkills = catalog.implicitSkills.filter(
    (skill) => !disabled.has(skill.packageId),
  );
  const resolveEnabled = (
    enabledCandidates: readonly SkillDescriptor[],
    allCandidates: readonly SkillDescriptor[],
    lookup: string,
    rawLoad: (lookup: string) => WorkflowSkill,
  ): SkillDescriptor => {
    try {
      return resolveSkillDescriptor(enabledCandidates, lookup);
    } catch (enabledError) {
      let rawDescriptor: SkillDescriptor;
      try {
        rawDescriptor = resolveSkillDescriptor(allCandidates, lookup);
      } catch {
        rawLoad(lookup);
        /* v8 ignore next -- the raw loader either returns the descriptor represented by the raw candidate set or throws its richer audit/ambiguity error. */
        throw enabledError;
      }
      throw new WorkflowSkillError(
        disabledSkillMessage(rawDescriptor.qualifiedName),
      );
    }
  };
  const assertPackageEnabled = (packageId: string): void => {
    if (!disabled.has(packageId)) return;
    const descriptor = catalog.skills.find(
      (skill) => skill.packageId === packageId,
    );
    throw new WorkflowSkillError(
      disabledSkillMessage(descriptor?.qualifiedName ?? packageId),
    );
  };
  return {
    skills: enabledSkills,
    implicitSkills: enabledImplicitSkills,
    warnings: catalog.warnings,
    audits: catalog.audits,
    load: (lookup) => {
      const descriptor = resolveEnabled(
        enabledSkills,
        catalog.skills,
        lookup,
        catalog.load,
      );
      return catalog.load(descriptor.qualifiedName);
    },
    loadImplicit: (lookup) => {
      const descriptor = resolveEnabled(
        enabledImplicitSkills,
        catalog.implicitSkills,
        lookup,
        catalog.loadImplicit,
      );
      return catalog.loadImplicit(descriptor.qualifiedName);
    },
    loadPackage: (packageId) =>
      disabled.has(packageId) ? undefined : catalog.loadPackage(packageId),
    search: (query, limit = 20) =>
      catalog
        .search(query, catalog.implicitSkills.length)
        .filter((skill) => !disabled.has(skill.packageId))
        .slice(0, Math.max(0, limit)),
    readResource: (lookup, path) => {
      const descriptor = resolveEnabled(
        enabledSkills,
        catalog.skills,
        lookup,
        catalog.load,
      );
      return catalog.readResource(descriptor.qualifiedName, path);
    },
    readPackageResource: (packageId, digest, path) => {
      assertPackageEnabled(packageId);
      return catalog.readPackageResource(packageId, digest, path);
    },
  };
}

export function loadWorkflowSkills(
  runtime: Pick<CliRuntime, "env">,
  workspace: string,
  lookups: readonly string[],
  disabledPackageIds: readonly string[] = [],
): readonly WorkflowSkill[] {
  const catalog = filterWorkflowSkillCatalog(
    discoverWorkflowSkillCatalog(runtime, workspace),
    disabledPackageIds,
  );
  return lookups
    .map((lookup) => catalog.load(lookup))
    .filter(
      (skill, index, skills) =>
        skills.findIndex(
          (candidate) => candidate.packageId === skill.packageId,
        ) === index,
    );
}

export function listWorkflowSkills(
  runtime: Pick<CliRuntime, "env">,
  workspace: string,
  options: { readonly includeUserControls?: boolean } = {},
): WorkflowSkillListResult {
  const catalog = discoverWorkflowSkillCatalog(runtime, workspace);
  const config =
    options.includeUserControls === false
      ? { enabled: true, disabledPackageIds: [] }
      : readUserSkillConfig(runtime);
  const disabled = new Set(config.disabledPackageIds);
  return {
    skills: catalog.skills.map(
      ({
        qualifiedName,
        name,
        description,
        relativePath,
        activationPolicy,
        packageId,
      }) => ({
        qualifiedName,
        name,
        description,
        relativePath,
        activationPolicy,
        disabled: disabled.has(packageId),
      }),
    ),
    warnings: catalog.warnings,
    audits: catalog.audits,
    exposure: exposeSkillCatalog({
      skills: catalog.implicitSkills,
      request: "",
    }),
    globallyEnabled: config.enabled,
  };
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function sanitizeWorkflowSkillOutputText(text: string): string {
  return sanitizeStatusLineText(redactSecretLikeText(text));
}

export function formatWorkflowSkillDiagnostics(
  audits: readonly SkillPackageAudit[],
): string {
  if (audits.length === 0) {
    return "No workflow skill packages found to audit.\n";
  }
  const lines = ["Workflow skill diagnostics:"];
  let blockedPackages = 0;
  let warningCount = 0;
  for (const audit of audits) {
    const blocker = audit.findings.some(
      (finding) => finding.severity === "blocker",
    );
    const warnings = audit.findings.filter(
      (finding) => finding.severity === "warning",
    );
    if (blocker) blockedPackages += 1;
    warningCount += warnings.length;
    const status = blocker ? "blocked" : warnings.length > 0 ? "warning" : "ok";
    lines.push(
      `- ${sanitizeWorkflowSkillOutputText(audit.qualifiedName)}: ${status}`,
    );
    for (const finding of audit.findings) {
      const severity = finding.severity === "blocker" ? "BLOCK" : "WARN";
      lines.push(
        `  - ${severity} [${finding.code}] ${sanitizeWorkflowSkillOutputText(finding.relativePath)}: ${sanitizeWorkflowSkillOutputText(finding.message)}`,
      );
    }
  }
  lines.push(
    `Summary: ${audits.length} ${plural(audits.length, "package", "packages")}, ${blockedPackages} blocked, ${warningCount} ${plural(warningCount, "warning", "warnings")}.`,
    "",
  );
  return lines.join("\n");
}

export function formatWorkflowSkillList(
  skills: readonly WorkflowSkillSummary[],
  options: { readonly globallyEnabled?: boolean } = {},
): string {
  if (skills.length === 0) {
    return options.globallyEnabled === false
      ? "Workflow skills are globally disabled.\nNo workflow skills found across repo, user, system, or extra scopes.\n"
      : "No workflow skills found across repo, user, system, or extra scopes.\n";
  }
  return [
    options.globallyEnabled === false
      ? "Workflow skills (globally disabled):"
      : "Workflow skills:",
    ...skills.map(
      (skill) =>
        `- ${sanitizeWorkflowSkillOutputText(skill.qualifiedName)}: ${sanitizeWorkflowSkillOutputText(skill.description)}${
          skill.activationPolicy === "explicit" ? " [explicit only]" : ""
        }${skill.disabled ? " [disabled by user]" : ""}`,
    ),
    "",
  ].join("\n");
}

function formatWorkflowSkillWarningMessage(message: string): string {
  return sanitizeWorkflowSkillOutputText(message.replace(/^Error: /u, ""));
}

export function formatWorkflowSkillListWarnings(
  warnings: readonly WorkflowSkillListWarning[],
): string {
  return warnings
    .map(
      (warning) =>
        `Warning: skipped workflow skill ${sanitizeWorkflowSkillOutputText(JSON.stringify(warning.name))}: ${formatWorkflowSkillWarningMessage(warning.message)}\n`,
    )
    .join("");
}
