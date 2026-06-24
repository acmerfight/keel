import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toolCallValidationError } from "../../src/tools/tool-error.ts";

describe("tool call validation errors", () => {
  test(`Given a Zod issue targets the argument payload root,
    When a tool call validation error is formatted,
    Then the message names the arguments root`, () => {
    const parsed = z.string().safeParse(1);
    if (parsed.success) {
      throw new Error("expected test parse to fail");
    }

    expect(
      toolCallValidationError(
        "Invalid provider tool call",
        "read",
        parsed.error,
      ).message,
    ).toBe(
      "Invalid provider tool call for read: arguments: Invalid input: expected string, received number",
    );
  });
});
