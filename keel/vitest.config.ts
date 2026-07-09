import { coverageConfigDefaults, defineConfig } from "vitest/config";

const coverage = {
  reporter: ["text", "lcov"],
  exclude: ["src/testing/**", ...coverageConfigDefaults.exclude],
  thresholds: {
    statements: 95,
    branches: 90,
    functions: 95,
    lines: 95,
  },
};

export default defineConfig({
  test: {
    coverage,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          sequence: { groupOrder: 1 },
          include: [
            "tests/agent/**/*.test.ts",
            "tests/core/**/*.test.ts",
            "tests/providers/**/*.test.ts",
            "tests/tools/**/*.test.ts",
            "tests/invariants/**/*.test.ts",
          ],
          testTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: "cli",
          sequence: { groupOrder: 2 },
          include: ["tests/cli/**/*.test.ts"],
          testTimeout: 30_000,
          fileParallelism: true,
        },
      },
    ],
  },
});
