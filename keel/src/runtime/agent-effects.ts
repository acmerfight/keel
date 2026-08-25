import type { LLMProvider } from "../llm/types.ts";
import type { McpProviderSchemaTarget } from "../mcp/provider-schema.ts";
import type { McpRuntime } from "../mcp/runtime-types.ts";
import type { MainBashRuntime } from "../permissions/bash.ts";
import type { SkillActivationCapability } from "../skills/model.ts";
import type { DelegationCapability } from "../tools/delegation.ts";
import type { AgentMemoryRuntime } from "../tools/memory.ts";

interface MainAgentMcpEffects {
  readonly runtime: McpRuntime;
  readonly schemaTarget: McpProviderSchemaTarget;
}

interface MainAgentDelegationEffects {
  readonly capability: DelegationCapability;
  readonly costBudgetProvider: LLMProvider;
}

interface CreateMainAgentEffectsOptions<
  Memory extends AgentMemoryRuntime = AgentMemoryRuntime,
> {
  readonly bash: MainBashRuntime;
  readonly hiddenWorkspacePaths: readonly string[];
  readonly memory?: Memory;
  readonly mcp?: MainAgentMcpEffects;
  readonly delegation?: MainAgentDelegationEffects;
  readonly skillActivation?: SkillActivationCapability;
}

interface MainAgentEffectsBase<
  Memory extends AgentMemoryRuntime = AgentMemoryRuntime,
> {
  readonly bash: MainBashRuntime;
  readonly hiddenWorkspacePaths: readonly string[];
  readonly memory?: Memory;
  readonly mcp?: MainAgentMcpEffects;
  readonly skillActivation?: SkillActivationCapability;
}

type MainAgentEffects<Memory extends AgentMemoryRuntime = AgentMemoryRuntime> =
  MainAgentEffectsBase<Memory> &
    (
      | {
          readonly delegation?: never;
          readonly costBudgetProvider?: never;
        }
      | {
          readonly delegation: DelegationCapability;
          readonly costBudgetProvider: LLMProvider;
        }
    );

export function createMainAgentEffects<Memory extends AgentMemoryRuntime>(
  options: CreateMainAgentEffectsOptions<Memory>,
): MainAgentEffects<Memory> {
  const shared = {
    bash: options.bash,
    hiddenWorkspacePaths: options.hiddenWorkspacePaths,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.skillActivation === undefined
      ? {}
      : { skillActivation: options.skillActivation }),
  };
  return options.delegation === undefined
    ? shared
    : {
        ...shared,
        delegation: options.delegation.capability,
        costBudgetProvider: options.delegation.costBudgetProvider,
      };
}
