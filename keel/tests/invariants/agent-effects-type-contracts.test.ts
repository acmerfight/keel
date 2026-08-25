import { describe, expectTypeOf, test } from "vitest";
import type { LLMProvider } from "../../src/llm/types.ts";
import type { McpProviderSchemaTarget } from "../../src/mcp/provider-schema.ts";
import type { McpRuntime } from "../../src/mcp/runtime-types.ts";
import type { createMainAgentEffects } from "../../src/runtime/agent-effects.ts";
import type { DelegationCapability } from "../../src/tools/delegation.ts";

type EffectOptions = Parameters<typeof createMainAgentEffects>[0];
type Effects = ReturnType<typeof createMainAgentEffects>;

describe("Main-agent effect assembly type contracts", () => {
  test("MCP runtime and provider schema target form one capability", () => {
    expectTypeOf<NonNullable<EffectOptions["mcp"]>>().toEqualTypeOf<{
      readonly runtime: McpRuntime;
      readonly schemaTarget: McpProviderSchemaTarget;
    }>();
  });

  test("delegation input requires its cost-budget provider", () => {
    expectTypeOf<NonNullable<EffectOptions["delegation"]>>().toEqualTypeOf<{
      readonly capability: DelegationCapability;
      readonly costBudgetProvider: LLMProvider;
    }>();
  });

  test("delegation output exposes capability and cost provider together", () => {
    type WithDelegation = Extract<
      Effects,
      { readonly delegation: DelegationCapability }
    >;
    type WithoutDelegation = Extract<Effects, { readonly delegation?: never }>;

    expectTypeOf<
      WithDelegation["costBudgetProvider"]
    >().toEqualTypeOf<LLMProvider>();
    expectTypeOf<
      WithoutDelegation["costBudgetProvider"]
    >().toEqualTypeOf<undefined>();
  });
});
