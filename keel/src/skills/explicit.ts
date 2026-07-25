import { WorkflowSkillError } from "./model.ts";

const EXPLICIT_SKILL_LOOKUP_PATTERN =
  /^(?:(?:repo|user|system|extra):(?:[a-f0-9]{12}:)?)?[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface ExplicitSkillInvocation {
  readonly lookup: string;
  readonly arguments: string;
}

export function parseExplicitSkillInvocation(
  input: string,
): ExplicitSkillInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("$")) return null;
  const separatorIndex = trimmed.search(/\s/u);
  const invocation =
    separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const lookup = invocation.slice(1);
  if (!EXPLICIT_SKILL_LOOKUP_PATTERN.test(lookup)) {
    throw new WorkflowSkillError(
      "Error: invalid $skill invocation; use $name, $scope:name, or $scope:root-id:name, optionally followed by task arguments.",
    );
  }
  return {
    lookup,
    arguments:
      separatorIndex === -1 ? "" : trimmed.slice(separatorIndex).trim(),
  };
}
