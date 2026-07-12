import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  exposeSkillCatalog,
  type SkillCatalogExposure,
} from "../skills/catalog.ts";
import type { SkillCatalog, WorkflowSkill } from "../skills/model.ts";
import {
  discoverSkillCatalog,
  type SkillDiscoveryOptions,
} from "../skills/project.ts";
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
    exposure: exposeSkillCatalog({
      skills: catalog.implicitSkills,
      request: "",
    }),
  };
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
