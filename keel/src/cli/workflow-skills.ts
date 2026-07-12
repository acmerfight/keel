import type { WorkflowSkill } from "../skills/model.ts";
import {
  discoverProjectSkillCatalog,
  loadProjectWorkflowSkill,
} from "../skills/project.ts";

const LOCAL_SKILL_ROOT = ".agents/skills";

export { WorkflowSkillError } from "../skills/model.ts";

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

export function loadWorkflowSkill(
  workspace: string,
  skillName: string,
): WorkflowSkill {
  return loadProjectWorkflowSkill(workspace, skillName);
}

export function listWorkflowSkills(workspace: string): WorkflowSkillListResult {
  const catalog = discoverProjectSkillCatalog(workspace);
  return {
    skills: catalog.skills.map(({ name, description, relativePath }) => ({
      name,
      description,
      relativePath,
    })),
    warnings: catalog.warnings,
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
