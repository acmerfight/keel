export const MAX_WORKFLOW_SKILL_RESOURCE_PATHS = 50;
export const MAX_WORKFLOW_SKILL_RESOURCE_ENTRY_VISITS = 500;
export const MAX_WORKFLOW_SKILL_RESOURCE_BYTES = 50 * 1024;

export const WORKFLOW_SKILL_RESOURCE_DIRECTORIES = [
  "references",
  "scripts",
  "assets",
];

const workflowSkillResourceDirectorySet = new Set(
  WORKFLOW_SKILL_RESOURCE_DIRECTORIES,
);

export function hasForbiddenSkillTextCharacter(
  text: string,
  options: { readonly allowTextWhitespace: boolean },
): boolean {
  for (const character of text) {
    const code = character.codePointAt(0);
    /* v8 ignore next -- iteration over a non-empty Unicode string always yields a code point. */
    if (code === undefined) continue;
    if (
      (code < 0x20 &&
        (!options.allowTextWhitespace ||
          (code !== 0x09 && code !== 0x0a && code !== 0x0d))) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x00ad ||
      code === 0x034f ||
      code === 0x061c ||
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0x3164 ||
      code === 0xfeff ||
      code === 0xffa0 ||
      code === 0xe0001 ||
      (code >= 0xe0020 && code <= 0xe007f)
    ) {
      return true;
    }
  }
  return false;
}

export function isWorkflowSkillResourcePath(path: string): boolean {
  if (
    path === "" ||
    hasForbiddenSkillTextCharacter(path, { allowTextWhitespace: false }) ||
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
