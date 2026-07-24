import { describe, expect, test } from "vitest";
import {
  CountOutputLimit,
  HeadByteOutputLimit,
  limitCountedOutput,
  TailByteOutputLimit,
  TempFileByteOutputCapture,
} from "../../src/tools/output-limit.ts";

describe("Output Limit Accountants", () => {
  test(`Given counted output reaches the item limit exactly,
    When the count accountant captures the result,
    Then it returns every item without claiming truncation`, () => {
    const output = new CountOutputLimit<string>(3);

    expect(output.append("alpha")).toBe(true);
    expect(output.append("beta")).toBe(true);
    expect(output.append("gamma")).toBe(true);

    expect(output.capture()).toEqual({
      items: ["alpha", "beta", "gamma"],
      truncated: false,
    });
  });

  test(`Given counted output exceeds the item limit,
    When the count accountant rejects the extra item,
    Then it keeps the capped prefix and reports truncation`, () => {
    const output = new CountOutputLimit<string>(2);

    expect(output.append("alpha")).toBe(true);
    expect(output.append("beta")).toBe(true);
    expect(output.append("gamma")).toBe(false);

    expect(output.capture()).toEqual({
      items: ["alpha", "beta"],
      truncated: true,
    });
  });

  test(`Given a complete counted list is sliced to the limit,
    When the count helper captures the result,
    Then exact-cap lists are not reported as truncated`, () => {
    expect(limitCountedOutput(["alpha", "beta"], 2)).toEqual({
      items: ["alpha", "beta"],
      truncated: false,
    });
    expect(limitCountedOutput(["alpha", "beta", "gamma"], 2)).toEqual({
      items: ["alpha", "beta"],
      truncated: true,
    });
  });

  test(`Given head byte output reaches the byte budget exactly,
    When the head accountant captures the result,
    Then it returns all bytes without claiming truncation`, () => {
    const output = new HeadByteOutputLimit(5);

    output.append(Buffer.from("hel"));
    output.append(Buffer.from("lo"));

    expect(output.capture()).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  test(`Given head byte output exceeds the byte budget,
    When the head accountant captures the result,
    Then it keeps the earliest bytes and reports truncation`, () => {
    const output = new HeadByteOutputLimit(5);

    output.append(Buffer.from("hello"));
    output.append(Buffer.from(" world"));

    expect(output.capture()).toEqual({
      text: "hello",
      truncated: true,
    });
  });

  test(`Given tail byte output reaches the byte budget exactly,
    When the tail accountant captures the result,
    Then it returns all bytes without claiming truncation`, () => {
    const output = new TailByteOutputLimit(5);

    output.append(Buffer.from("hel"));
    output.append(Buffer.from("lo"));

    expect(output.capture()).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  test(`Given tail byte output exceeds the byte budget,
    When the tail accountant captures the result,
    Then it keeps the latest bytes and reports truncation`, () => {
    const output = new TailByteOutputLimit(5);

    output.append(Buffer.from("hello"));
    output.append(Buffer.from(" world"));

    expect(output.capture()).toEqual({
      text: "world",
      truncated: true,
    });
  });

  test(`Given artifact output crosses the memory spill threshold,
    When the artifact capture is finalized,
    Then it returns the complete output from temporary storage`, () => {
    const output = new TempFileByteOutputCapture(
      "keel-output-limit-test-",
      10,
      3,
    );

    output.append(Buffer.from("hel"));
    output.append(Buffer.from("lo"));

    expect(output.capture()).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  test(`Given artifact output has already reached its byte budget,
    When another stream chunk arrives,
    Then it preserves the capped output and reports truncation`, () => {
    const output = new TempFileByteOutputCapture(
      "keel-output-limit-test-",
      5,
      5,
    );

    output.append(Buffer.from("hello"));
    output.append(Buffer.from(" world"));

    expect(output.capture()).toEqual({
      text: "hello",
      truncated: true,
    });
  });

  test(`Given an artifact capture has already been cleaned up,
    When a late stream chunk arrives,
    Then it ignores the chunk without recreating temporary storage`, () => {
    const output = new TempFileByteOutputCapture(
      "keel-output-limit-test-",
      10,
      1,
    );

    output.cleanup();

    expect(() => output.append(Buffer.from("late"))).not.toThrow();
  });
});
