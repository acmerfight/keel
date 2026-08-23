import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  BashRuntime,
  ExecutionPosture,
  MainBashRuntime,
} from "../../src/permissions/bash.ts";
import { bashRuntimeExposesTool } from "../../src/permissions/bash.ts";

describe("bash state invariants", () => {
  test(`Given the invocation execution posture,
    When modeling the supported product states,
    Then trusted and reviewed are the only user-selectable meanings`, () => {
    const postures: readonly ExecutionPosture[] = ["trusted", "reviewed"];

    expect(postures).toEqual(["trusted", "reviewed"]);
  });

  test(`Given a concrete Bash capability context,
    When deriving tool exposure,
    Then only a capability-disabled child hides Bash`, () => {
    const runtimes: readonly BashRuntime[] = [
      { kind: "disabled" },
      { kind: "trusted" },
      {
        kind: "reviewed",
        permission: {
          review: () => ({ type: "deny", message: "not executed" }),
        },
      },
    ];

    expect(runtimes.map(bashRuntimeExposesTool)).toEqual([false, true, true]);
  });

  test(`Given the main-agent execution boundary,
    When its Bash runtime states are modeled,
    Then capability-disabled Bash cannot be represented`, () => {
    const runtimes = [
      { kind: "trusted" },
      {
        kind: "reviewed",
        permission: {
          review: () => ({ type: "deny", message: "not executed" }),
        },
      },
    ] satisfies readonly MainBashRuntime[];

    expect(runtimes.map((runtime) => runtime.kind)).toEqual([
      "trusted",
      "reviewed",
    ]);
  });

  test(`Given session persistence and CLI composition,
    When authorization state is inspected,
    Then Bash approvals are invocation-owned and never persisted`, () => {
    const sources = [
      "src/cli/session-store/model.ts",
      "src/cli/session-store/records.ts",
      "src/cli/session-store/store.ts",
      "src/cli/session-catalog-format.ts",
    ].map((path) => readFileSync(path, "utf8"));

    for (const source of sources) {
      expect(source).not.toMatch(/bashApprovalGrant/u);
      expect(source).not.toMatch(/bash_approval_/u);
    }
  });
});
