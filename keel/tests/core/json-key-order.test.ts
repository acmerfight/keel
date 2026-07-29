import { describe, expect, test } from "vitest";
import { compareJsonObjectKeys } from "../../src/core/json-key-order.ts";

describe("JSON key ordering", () => {
  test(`Given JSON object keys include non-ASCII text,
    When Keel orders keys for canonical digests,
    Then the order is based on Unicode code points instead of process locale`, () => {
    // Given
    const keys = ["ä", "z", "😀", "a"];

    // When
    const ordered = [...keys].sort(compareJsonObjectKeys);

    // Then
    expect(ordered).toEqual(["a", "z", "ä", "😀"]);
    expect(compareJsonObjectKeys("same", "same")).toBe(0);
    expect(compareJsonObjectKeys("key", "keySuffix")).toBeLessThan(0);
    expect(compareJsonObjectKeys("keySuffix", "key")).toBeGreaterThan(0);
  });
});
