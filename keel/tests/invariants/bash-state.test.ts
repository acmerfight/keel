import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  type BashMode,
  type BashPolicy,
  bashModeExposesTool,
  bashModeFromPolicy,
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

  test("Given user-facing bash policies, When deriving internal bash modes, Then each mode has one tool exposure meaning", () => {
    const cases: ReadonlyArray<{
      readonly policy: BashPolicy;
      readonly mode: BashMode;
      readonly exposesTool: boolean;
    }> = [
      { policy: "deny", mode: "disabled", exposesTool: false },
      { policy: "ask", mode: "ask", exposesTool: true },
      { policy: "trusted", mode: "trusted", exposesTool: true },
    ];

    for (const entry of cases) {
      const mode = bashModeFromPolicy(entry.policy);
      expect(mode).toBe(entry.mode);
      expect(bashModeExposesTool(mode)).toBe(entry.exposesTool);
    }
  });
});
