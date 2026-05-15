import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("module boundaries", () => {
  test("agent/loop.ts does not import fs or child_process", () => {
    const source = readFileSync("src/agent/loop.ts", "utf8");
    expect(source).not.toMatch(/import.*from.*['"](?:node:)?fs['"]/);
    expect(source).not.toMatch(/import.*from.*['"](?:node:)?child_process['"]/);
  });

  test("agent/ does not import cli/", () => {
    const source = readFileSync("src/agent/loop.ts", "utf8");
    expect(source).not.toMatch(/import.*from.*['"].*\/cli\//);
  });

  test("llm/ does not import cli/", () => {
    const source = readFileSync("src/llm/registry.ts", "utf8");
    expect(source).not.toMatch(/import.*from.*['"].*\/cli\//);
  });

  test("llm/ does not import agent/", () => {
    const source = readFileSync("src/llm/registry.ts", "utf8");
    expect(source).not.toMatch(/import.*from.*['"].*\/agent\//);
  });
});
