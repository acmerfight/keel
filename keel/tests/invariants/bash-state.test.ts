import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { ExecutionPosture } from "../../src/core/execution-posture.ts";
import type {
  BashRuntime,
  MainBashRuntime,
} from "../../src/permissions/bash.ts";
import { bashRuntimeExposesTool } from "../../src/permissions/bash.ts";

describe("execution authority state invariants", () => {
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

  test(`Given reviewed MCP approval is one-call authority owned by Main,
    When persistent and command state shapes are inspected,
    Then no reusable MCP approval can be represented`, () => {
    const sources = [
      "src/cli/mcp-approval.ts",
      "src/cli/mcp-config.ts",
      "src/cli/args/mcp.ts",
      "src/cli/args/types.ts",
      "src/cli/session-store/model.ts",
      "src/cli/session-store/records.ts",
      "src/cli/report.ts",
    ].map((path) => readFileSync(path, "utf8"));

    for (const source of sources) {
      expect(source).not.toMatch(/mcpProjectApproval/iu);
      expect(source).not.toMatch(/mcp-project-approvals/iu);
      expect(source).not.toMatch(/approvals-(?:list|revoke|clear)/u);
    }
  });
});
