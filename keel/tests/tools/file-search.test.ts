import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeRipgrepPath } from "../../src/tools/file-search.ts";

describe("File Search Shared Helpers", () => {
  test(`Given ripgrep reports an absolute file path,
    When the path is normalized for tool output,
    Then it is rendered relative to the workspace root`, () => {
    // Given
    const workspace = join(process.cwd(), "workspace");
    const absoluteMatch = join(workspace, "src", "app.ts");

    // When
    const normalized = normalizeRipgrepPath(workspace, absoluteMatch);

    // Then
    expect(normalized).toBe("src/app.ts");
  });
});
