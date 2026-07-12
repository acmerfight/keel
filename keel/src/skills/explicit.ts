import { WorkflowSkillError } from "./model.ts";

const EXPLICIT_SKILL_PATTERN =
  /^\$((?:(?:repo|user|system|extra):(?:[a-f0-9]{12}:)?)?[a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/u;

export interface ExplicitSkillInvocation {
  readonly lookup: string;
  readonly arguments: string;
}

export function parseExplicitSkillInvocation(
  input: string,
): ExplicitSkillInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("$")) return null;
  const match = EXPLICIT_SKILL_PATTERN.exec(trimmed);
  if (match === null) {
    throw new WorkflowSkillError(
      "Error: invalid $skill invocation; use $name, $scope:name, or $scope:root-id:name, optionally followed by task arguments.",
    );
  }
  const lookup = match[1];
  /* v8 ignore next 3 -- the accepted pattern has a mandatory first capture. */
  if (lookup === undefined) {
    throw new WorkflowSkillError("Error: $skill requires a skill name.");
  }
  return {
    lookup,
    arguments: match[2]?.trim() ?? "",
  };
}
