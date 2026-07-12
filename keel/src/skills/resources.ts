export const MAX_WORKFLOW_SKILL_RESOURCE_PATHS = 50;
export const MAX_WORKFLOW_SKILL_RESOURCE_ENTRY_VISITS = 500;

export const WORKFLOW_SKILL_RESOURCE_DIRECTORIES = [
  "references",
  "scripts",
  "assets",
];

const workflowSkillResourceDirectorySet = new Set(
  WORKFLOW_SKILL_RESOURCE_DIRECTORIES,
);

function hasControlCharacter(path: string): boolean {
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isWorkflowSkillResourcePath(path: string): boolean {
  if (
    path === "" ||
    hasControlCharacter(path) ||
    path.includes("\\") ||
    path.startsWith("/")
  ) {
    return false;
  }
  const parts = path.split("/");
  if (parts.length < 2) {
    return false;
  }
  const [directory] = parts;
  if (
    directory === undefined ||
    !workflowSkillResourceDirectorySet.has(directory)
  ) {
    return false;
  }
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
