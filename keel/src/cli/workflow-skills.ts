import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { SkillPackageAudit } from "../skills/audit.ts";
import {
  exposeSkillCatalog,
  type SkillCatalogExposure,
} from "../skills/catalog.ts";
import type { SkillCatalog, WorkflowSkill } from "../skills/model.ts";
import {
  discoverSkillCatalog,
  type SkillDiscoveryOptions,
} from "../skills/project.ts";
import { sanitizeStatusLineText } from "./output.ts";
import type { CliRuntime } from "./runtime.ts";

export { WorkflowSkillError } from "../skills/model.ts";

export interface WorkflowSkillSummary {
  readonly qualifiedName: string;
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly activationPolicy: "implicit" | "explicit";
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

export function loadWorkflowSkills(
  runtime: Pick<CliRuntime, "env">,
  workspace: string,
  lookups: readonly string[],
): readonly WorkflowSkill[] {
  const catalog = discoverWorkflowSkillCatalog(runtime, workspace);
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
): WorkflowSkillListResult {
  const catalog = discoverWorkflowSkillCatalog(runtime, workspace);
  return {
    skills: catalog.skills.map(
      ({
        qualifiedName,
        name,
        description,
        relativePath,
        activationPolicy,
      }) => ({
        qualifiedName,
        name,
        description,
        relativePath,
        activationPolicy,
      }),
    ),
    warnings: catalog.warnings,
    audits: catalog.audits,
    exposure: exposeSkillCatalog({
      skills: catalog.implicitSkills,
      request: "",
    }),
  };
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
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
    lines.push(`- ${sanitizeStatusLineText(audit.qualifiedName)}: ${status}`);
    for (const finding of audit.findings) {
      const severity = finding.severity === "blocker" ? "BLOCK" : "WARN";
      lines.push(
        `  - ${severity} [${finding.code}] ${sanitizeStatusLineText(finding.relativePath)}: ${finding.message}`,
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
): string {
  if (skills.length === 0) {
    return "No workflow skills found across repo, user, system, or extra scopes.\n";
  }
  return [
    "Workflow skills:",
    ...skills.map(
      (skill) =>
        `- ${skill.qualifiedName}: ${skill.description}${
          skill.activationPolicy === "explicit" ? " [explicit only]" : ""
        }`,
    ),
    "",
  ].join("\n");
}

function formatWorkflowSkillWarningMessage(message: string): string {
  return sanitizeStatusLineText(message.replace(/^Error: /u, ""));
}

export function formatWorkflowSkillListWarnings(
  warnings: readonly WorkflowSkillListWarning[],
): string {
  return warnings
    .map(
      (warning) =>
        `Warning: skipped workflow skill ${sanitizeStatusLineText(JSON.stringify(warning.name))}: ${formatWorkflowSkillWarningMessage(warning.message)}\n`,
    )
    .join("");
}
