import { describe, expect, test } from "vitest";
import { prohibitedSensitiveTextCategory } from "../../src/core/sensitive-text.ts";

describe("automatic-memory sensitive-text admission", () => {
  test.each([
    ["secret", "sk-liveCandidateBoundary1234567890"],
    ["contact", "Contact owner@example.com"],
    ["identity", "身份证号: 11010519491231002X"],
    ["financial", "Card: 4242 4242 4242 4242"],
    ["health", "诊断：高血压"],
    ["private_customer", "客户隐私数据：账户 48291 有争议"],
    ["address", "家庭住址：上海市示例路 12 号"],
  ])("classifies prohibited %s evidence", (category, text) => {
    expect(prohibitedSensitiveTextCategory(text)).toBe(category);
  });

  test.each([
    "Release tags use a v prefix.",
    "Preserve invoice IDs because the audit system references them.",
    "Use RFC 4242 when documenting the protocol.",
  ])("does not reject ordinary durable project evidence: %s", (text) => {
    expect(prohibitedSensitiveTextCategory(text)).toBeUndefined();
  });
});
