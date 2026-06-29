import { describe, expect, test } from "vitest";
import {
  locateExactEditSpans,
  locateUniqueEditSpan,
} from "../../src/tools/edit-match.ts";

describe("Edit Match", () => {
  test(`Given an empty search string,
    When locating a unique edit span,
    Then it reports not found without scanning forever`, () => {
    // Given / When
    const result = locateUniqueEditSpan("alpha\n", "");

    // Then
    expect(result).toEqual({ status: "not_found" });
    expect(locateExactEditSpans("alpha\n", "")).toEqual([]);
  });
});
