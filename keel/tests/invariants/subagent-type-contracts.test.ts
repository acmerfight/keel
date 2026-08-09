import { describe, expectTypeOf, test } from "vitest";
import type { RunAgentOptions } from "../../src/agent/loop.ts";
import type {
  BeginModelOperationOptions,
  ModelOperationInstrumentation,
} from "../../src/agent/model-operations.ts";
import type { LLMProvider, Usage } from "../../src/llm/types.ts";
import type {
  DelegationCapability,
  DelegationExecutor,
  DelegationToolResult,
} from "../../src/tools/delegation.ts";
import type { ExecuteToolCallOptions } from "../../src/tools/execution.ts";

type Extends<Left, Right> = [Left] extends [Right] ? true : false;

type ModelOperationBase = Pick<
  BeginModelOperationOptions,
  "recorder" | "owner" | "provider" | "model" | "costModel"
>;

type RunAgentBase = Pick<
  RunAgentOptions,
  | "workspace"
  | "provider"
  | "userMessage"
  | "systemPrompt"
  | "signal"
  | "bash"
  | "stopPolicy"
>;

describe("subagent static type contracts", () => {
  test(`Given only a prepared delegation batch may enter tool dispatch,
    When capability and executor authority types are compared,
    Then the admission capability cannot be passed as an executor`, () => {
    expectTypeOf<
      Extends<DelegationCapability, DelegationExecutor>
    >().toEqualTypeOf<false>();
    expectTypeOf<ExecuteToolCallOptions["delegation"]>().toEqualTypeOf<
      DelegationExecutor | undefined
    >();
  });

  test(`Given delegation accounting distinguishes first delivery from replay,
    When capability result types are compared,
    Then a result without an accounting disposition is not assignable`, () => {
    type MissingAccountingDisposition = {
      readonly ok: true;
      readonly content: string;
    };
    type SuccessfulRejection = {
      readonly delivery: "rejected";
      readonly ok: true;
      readonly content: string;
    };

    expectTypeOf<
      Extends<MissingAccountingDisposition, DelegationToolResult>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<SuccessfulRejection, DelegationToolResult>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extract<DelegationToolResult, { readonly delivery: "fresh" }>["usage"]
    >().toEqualTypeOf<Usage>();
    expectTypeOf<
      Extract<DelegationToolResult, { readonly delivery: "replayed" }>["usage"]
    >().toEqualTypeOf<undefined>();
  });

  test(`Given model-operation attribution belongs to a child execution,
    When operation request types are compared,
    Then child turns require attribution and main turns reject it`, () => {
    type ChildWithoutAttribution = ModelOperationBase & {
      readonly purpose: "subagent_turn";
      readonly recoveryFor: null;
    };
    type MainWithChildAttribution = ModelOperationBase & {
      readonly attribution: {
        readonly type: "subagent";
        readonly delegationId: string;
        readonly childRunId: string;
      };
      readonly purpose: "agent_turn";
      readonly recoveryFor: null;
    };

    expectTypeOf<
      Extends<ChildWithoutAttribution, BeginModelOperationOptions>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<MainWithChildAttribution, BeginModelOperationOptions>
    >().toEqualTypeOf<false>();
  });

  test(`Given a read-only child returns a normal final message under a host budget,
    When run options omit the budget or add delegation,
    Then both invalid execution modes are not assignable`, () => {
    type ChildWithoutBudget = RunAgentBase & {
      readonly toolProfile: "read-only-subagent";
      readonly userMessageOrigin: {
        readonly type: "runtime_subagent_delegation";
      };
    };
    type ChildWithDelegation = ChildWithoutBudget & {
      readonly costBudgetProvider: LLMProvider;
      readonly delegation: DelegationCapability;
    };

    expectTypeOf<
      Extends<ChildWithoutBudget, RunAgentOptions>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<ChildWithDelegation, RunAgentOptions>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extract<
        RunAgentOptions,
        { readonly toolProfile: "read-only-subagent" }
      >["costBudgetProvider"]
    >().toEqualTypeOf<LLMProvider>();
  });

  test(`Given child model operations carry immutable identity attribution,
    When instrumentation variants are inspected,
    Then attributed and unattributed modes remain distinct`, () => {
    expectTypeOf<
      Extract<
        ModelOperationInstrumentation,
        { readonly attribution: { readonly type: "subagent" } }
      >
    >().not.toEqualTypeOf<never>();
  });
});
