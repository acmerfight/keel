import type { ProjectInstructions } from "../agent/prompt.ts";
import {
  appendDelegationToSystemPrompt,
  buildAgentSystemPrompt,
} from "../agent/prompt.ts";
import type { DelegatingAgentPolicy } from "../core/agent-policy.ts";
import type { SkillDescriptor } from "../skills/model.ts";

interface MainAgentDelegationPrompt {
  readonly policy: DelegatingAgentPolicy;
  readonly background: boolean;
}

interface BuildMainAgentSystemPromptOptions {
  readonly workspace: string;
  readonly platform: string;
  readonly projectInstructions?: ProjectInstructions;
  readonly skillCatalog?: readonly SkillDescriptor[];
  readonly delegation?: MainAgentDelegationPrompt;
}

export function buildMainAgentSystemPrompt(
  options: BuildMainAgentSystemPromptOptions,
): string {
  const baseSystemPrompt = buildAgentSystemPrompt({
    workspace: options.workspace,
    platform: options.platform,
    ...(options.projectInstructions === undefined
      ? {}
      : { projectInstructions: options.projectInstructions }),
    ...(options.skillCatalog === undefined
      ? {}
      : { skillCatalog: options.skillCatalog }),
  });
  return options.delegation === undefined
    ? baseSystemPrompt
    : appendDelegationToSystemPrompt(
        baseSystemPrompt,
        options.delegation.policy,
        {
          background: options.delegation.background,
          nestedReadOnly: options.delegation.policy === "explicit",
          writer: options.delegation.policy === "explicit",
        },
      );
}
