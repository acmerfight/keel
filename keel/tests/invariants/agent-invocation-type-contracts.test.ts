import { describe, expectTypeOf, test } from "vitest";
import type { createMainAgentEffects } from "../../src/runtime/agent-effects.ts";
import type { runMainAgentInvocation } from "../../src/runtime/agent-invocation.ts";

type Invocation = Parameters<typeof runMainAgentInvocation>[0];
type OneShot = Extract<Invocation, { readonly kind: "one_shot" }>;
type InteractiveTurn = Extract<
  Invocation,
  { readonly kind: "interactive_turn" }
>;
type HasProperty<Value, Key extends PropertyKey> = Key extends keyof Value
  ? true
  : false;
type Extends<Left, Right> = [Left] extends [Right] ? true : false;
type RuntimeOwnedProperty =
  | keyof OneShot["assembly"]
  | keyof ReturnType<typeof createMainAgentEffects>
  | "stopPolicy"
  | "toolProfile";

describe("Main-agent invocation type contracts", () => {
  test(`Given one-shot and interactive turns have different lifecycle roots,
    When their required state is inspected,
    Then each mode admits only its own entry state`, () => {
    expectTypeOf<
      HasProperty<OneShot["lifecycle"], "userMessage">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      HasProperty<OneShot["lifecycle"], "ledger">
    >().toEqualTypeOf<false>();
    expectTypeOf<
      HasProperty<InteractiveTurn["lifecycle"], "ledger">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      HasProperty<InteractiveTurn["lifecycle"], "userMessage">
    >().toEqualTypeOf<false>();
  });

  test(`Given common loop assembly belongs to the runtime boundary,
    When mode-specific lifecycle inputs are inspected,
    Then neither mode can override effects or the default stop policy`, () => {
    expectTypeOf<
      Extract<keyof OneShot["lifecycle"], RuntimeOwnedProperty>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof InteractiveTurn["lifecycle"], RuntimeOwnedProperty>
    >().toEqualTypeOf<never>();
  });

  test(`Given interactive agent control requires a result continuation budget,
    When its lifecycle variants are compared,
    Then control and budget are present together or absent together`, () => {
    type InteractiveLifecycle = InteractiveTurn["lifecycle"];
    type WithControl = Extract<
      InteractiveLifecycle,
      { readonly agentControl: unknown }
    >;
    type WithoutControl = Extract<
      InteractiveLifecycle,
      { readonly agentControl?: never }
    >;
    type ControlWithoutBudget = Omit<WithControl, "agentControlResultBudget">;
    type BudgetWithoutControl = Omit<WithControl, "agentControl">;

    expectTypeOf<WithControl>().not.toEqualTypeOf<never>();
    expectTypeOf<WithoutControl>().not.toEqualTypeOf<never>();
    expectTypeOf<
      Extends<ControlWithoutBudget, InteractiveLifecycle>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<BudgetWithoutControl, InteractiveLifecycle>
    >().toEqualTypeOf<false>();
  });

  test(`Given memory review is interactive-only,
    When mode-specific effect inputs are inspected,
    Then one-shot accepts direct memory while interactive accepts both kinds`, () => {
    type OneShotMemory = NonNullable<OneShot["assembly"]["effects"]["memory"]>;
    type InteractiveMemory = NonNullable<
      InteractiveTurn["assembly"]["effects"]["memory"]
    >;

    expectTypeOf<OneShotMemory["kind"]>().toEqualTypeOf<"direct">();
    expectTypeOf<InteractiveMemory["kind"]>().toEqualTypeOf<
      "direct" | "reviewed"
    >();
  });
});
