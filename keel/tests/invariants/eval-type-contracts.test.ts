import { describe, expectTypeOf, test } from "vitest";
import type {
  EvalResultCondition,
  EvalResultConditionForTask,
  EvalResultVerdict,
  EvalTrialObservation,
} from "../../src/eval/result-schema.ts";
import type {
  DelegationPairEvalTask,
  MemoryPairEvalTask,
  StandardEvalTask,
} from "../../src/eval/task.ts";

type Extends<Left, Right> = [Left] extends [Right] ? true : false;

describe("eval static type contracts", () => {
  test(`Given trial outcomes are trusted internal facts,
    When contradictory variants are compared,
    Then harness, task, and pass contradictions are not assignable`, () => {
    type TimeoutWithTaskOutcome = {
      readonly harnessOutcome: "timeout";
      readonly taskOutcome: "verified";
    };
    type FailedTaskThatPasses = {
      readonly harnessOutcome: "completed";
      readonly taskOutcome: "verify_failed";
      readonly pass: true;
    };

    expectTypeOf<
      Extends<TimeoutWithTaskOutcome, EvalTrialObservation>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<FailedTaskThatPasses, EvalResultVerdict>
    >().toEqualTypeOf<false>();
  });

  test(`Given delegation selection belongs only to eligible result conditions,
    When missing and forbidden selection shapes are compared,
    Then both contradictions are not assignable`, () => {
    type TreatmentWithoutSelection = {
      readonly condition: "delegation_treatment";
      readonly requiredToPass: true;
    };
    type ControlWithSelection = {
      readonly condition: "delegation_control";
      readonly requiredToPass: false;
      readonly delegationSelection: {
        readonly status: "observed";
        readonly policy: "require_one";
        readonly childRuns: 1;
        readonly satisfied: true;
      };
    };

    expectTypeOf<
      Extends<TreatmentWithoutSelection, EvalResultCondition>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<ControlWithSelection, EvalResultCondition>
    >().toEqualTypeOf<false>();
  });

  test(`Given each task kind owns a fixed set of trial conditions,
    When cross-kind conditions are compared,
    Then only the matching condition is assignable`, () => {
    type StandardCondition = {
      readonly condition: "standard";
      readonly requiredToPass: true;
    };
    type MemoryCondition = {
      readonly condition: "memory_enabled";
      readonly requiredToPass: true;
    };
    type DelegationCondition = {
      readonly condition: "delegation_treatment";
      readonly requiredToPass: true;
      readonly delegationSelection: {
        readonly status: "unavailable";
        readonly policy: "require_one";
      };
    };

    expectTypeOf<
      Extends<StandardCondition, EvalResultConditionForTask<StandardEvalTask>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Extends<DelegationCondition, EvalResultConditionForTask<StandardEvalTask>>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<MemoryCondition, EvalResultConditionForTask<MemoryPairEvalTask>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Extends<
        DelegationCondition,
        EvalResultConditionForTask<DelegationPairEvalTask>
      >
    >().toEqualTypeOf<true>();
  });
});
