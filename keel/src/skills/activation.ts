import { posix } from "node:path";
import type { WorkflowSkill } from "./model.ts";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function skillBaseDirectory(relativePath: string): string {
  return posix.dirname(relativePath);
}

export function formatSkillActivation(skill: WorkflowSkill): string {
  const resources =
    skill.resourcePaths.length === 0
      ? "    <none />"
      : skill.resourcePaths
          .map((path) => `    <path>${escapeXml(path)}</path>`)
          .join("\n");
  return [
    `<skill_activation name="${escapeXml(skill.name)}" source="${escapeXml(skill.relativePath)}">`,
    `  <base_directory>${escapeXml(skillBaseDirectory(skill.relativePath))}</base_directory>`,
    "  <instructions>",
    escapeXml(skill.content),
    "  </instructions>",
    "  <resources>",
    resources,
    "  </resources>",
    "</skill_activation>",
  ].join("\n");
}
