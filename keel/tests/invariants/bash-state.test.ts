import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const cliEntrySource = readFileSync("src/cli/index.ts", "utf8");
const interactiveSessionSource = readFileSync(
  "src/cli/interactive-session.ts",
  "utf8",
);

describe("bash state invariants", () => {
  test("Given CLI bash configuration, When modeling run state, Then bash exposure and policy are not stored as independent fields", () => {
    expect(cliEntrySource).not.toMatch(/readonly allowBash: boolean;/);
    expect(interactiveSessionSource).not.toMatch(
      /readonly allowBash: boolean;/,
    );
  });
});
