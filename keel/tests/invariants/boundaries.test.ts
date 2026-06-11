import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

interface LayerRule {
  readonly layer: string;
  readonly contract: string;
  readonly forbidden: readonly RegExp[];
}

const layerRules: readonly LayerRule[] = [
  {
    layer: "src/agent",
    contract: "does not import fs, child_process, or cli/",
    forbidden: [
      /^(?:node:)?fs(?:\/|$)/,
      /^(?:node:)?child_process$/,
      /\/cli\//,
    ],
  },
  {
    layer: "src/llm",
    contract: "does not import cli/ or agent/",
    forbidden: [/\/cli\//, /\/agent\//],
  },
];

function layerFiles(layer: string): readonly string[] {
  return readdirSync(layer, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(layer, name));
}

const importSpecifierPatterns = [
  // Static imports and re-exports: import ... from "x", export ... from "x"
  /\bfrom\s+["']([^"']+)["']/g,
  // Bare side-effect imports: import "x"
  /\bimport\s+["']([^"']+)["']/g,
  // Dynamic imports: import("x")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function importSpecifiers(source: string): readonly string[] {
  return importSpecifierPatterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
}

describe("module boundaries", () => {
  for (const { layer, contract, forbidden } of layerRules) {
    test(`every file in ${layer}/ ${contract}`, () => {
      const files = layerFiles(layer);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          const violated = forbidden.find((pattern) => pattern.test(specifier));
          expect(
            violated,
            `${file} imports "${specifier}" which violates: ${layer}/ ${contract}`,
          ).toBeUndefined();
        }
      }
    });
  }
});
