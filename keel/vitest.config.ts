import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "lcov"],
      exclude: ["src/testing/**", ...coverageConfigDefaults.exclude],
    },
  },
});
