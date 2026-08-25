import type { AgentEvent } from "../agent/events.ts";
import {
  type MainAgentRunOptions,
  type MainAgentRunTurnOptions,
  runAgent,
  runAgentTurn,
} from "../agent/loop.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { AgentMemoryRuntime } from "../tools/memory.ts";
import {
  type CreateMainAgentEffectsOptions,
  createMainAgentEffects,
  type MainAgentEffects,
} from "./agent-effects.ts";

type DirectAgentMemory = Extract<
  AgentMemoryRuntime,
  { readonly kind: "direct" }
>;

interface MainAgentInvocationAssembly<
  Memory extends AgentMemoryRuntime = AgentMemoryRuntime,
> {
  readonly workspace: string;
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly effects: CreateMainAgentEffectsOptions<Memory>;
}

type InvocationAssemblyKey =
  | keyof MainAgentInvocationAssembly
  | keyof MainAgentEffects
  | "stopPolicy"
  | "toolProfile";

type WithoutInvocationAssembly<Options> = Options extends unknown
  ? Omit<Options, InvocationAssemblyKey>
  : never;

type MainAgentInvocation =
  | {
      readonly kind: "one_shot";
      readonly assembly: MainAgentInvocationAssembly<DirectAgentMemory>;
      readonly lifecycle: WithoutInvocationAssembly<MainAgentRunOptions>;
    }
  | {
      readonly kind: "interactive_turn";
      readonly assembly: MainAgentInvocationAssembly;
      readonly lifecycle: WithoutInvocationAssembly<MainAgentRunTurnOptions>;
    };

function assembleMainAgentInvocation<Memory extends AgentMemoryRuntime>(
  assembly: MainAgentInvocationAssembly<Memory>,
) {
  return {
    workspace: assembly.workspace,
    provider: assembly.provider,
    systemPrompt: assembly.systemPrompt,
    signal: assembly.signal,
    ...createMainAgentEffects(assembly.effects),
    stopPolicy: defaultStopPolicy(),
  };
}

export function runMainAgentInvocation(
  options: MainAgentInvocation,
): AsyncGenerator<AgentEvent> {
  if (options.kind === "one_shot") {
    return runAgent({
      ...assembleMainAgentInvocation(options.assembly),
      ...options.lifecycle,
    });
  }
  return runAgentTurn({
    ...assembleMainAgentInvocation(options.assembly),
    ...options.lifecycle,
  });
}
