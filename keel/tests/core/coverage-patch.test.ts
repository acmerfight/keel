import { describe, expect, test } from "vitest";
import { parseChangedLines } from "../../src/core/coverage-patch.ts";

describe("patch coverage diff parsing", () => {
  test(`Given a diff contains a malformed hunk header,
    When changed lines are parsed,
    Then the malformed hunk is ignored without losing later valid hunks`, () => {
    // Given
    const diff = [
      "+++ b/src/feature.ts",
      "@@ malformed @@",
      "@@ -1 +3,2 @@",
    ].join("\n");

    // When
    const changedLines = parseChangedLines(diff);

    // Then
    expect([...changedLines.get("src/feature.ts") ?? []]).toEqual([3, 4]);
  });
});
