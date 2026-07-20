import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  type BashMode,
  type BashPolicy,
  type BashRuntime,
  bashModeFromPolicy,
  bashRuntimeExposesTool,
} from "../../src/permissions/bash.ts";

const cliEntrySource = readFileSync("src/cli/index.ts", "utf8");
const interactiveSessionSource = readFileSync(
  "src/cli/interactive-session.ts",
  "utf8",
);

describe("bash state invariants", () => {
  test("Given CLI bash configuration, When modeling run state, Then bash exposure and policy are not stored as independent fields", () => {
    for (const source of [cliEntrySource, interactiveSessionSource]) {
      expect(source).not.toMatch(/readonly allowBash: boolean;/);
      expect(source).not.toMatch(/readonly bashPolicy: BashPolicy;/);
    }
  });

  test("Given user-facing bash policies, When deriving internal CLI modes, Then each policy has one mode", () => {
    const cases: ReadonlyArray<{
      readonly policy: BashPolicy;
      readonly mode: BashMode;
    }> = [
      { policy: "deny", mode: "disabled" },
      { policy: "ask", mode: "ask" },
      { policy: "trusted", mode: "trusted" },
    ];

    for (const entry of cases) {
      expect(bashModeFromPolicy(entry.policy)).toBe(entry.mode);
    }
  });

  test("Given runtime bash postures, When deriving tool exposure, Then each valid posture has one exposure meaning", () => {
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
});
