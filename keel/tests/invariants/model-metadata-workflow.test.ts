import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("Model Metadata Drift Workflow", () => {
  test(`Given model metadata drift is an advisory monitor,
    When the GitHub workflow is inspected,
    Then it runs on schedule or manually and writes a job summary`, () => {
    // Given
    const workflow = readFileSync(
      join(
        process.cwd(),
        "..",
        ".github",
        "workflows",
        "model-metadata-drift.yml",
      ),
      "utf8",
    );

    // Then
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("working-directory: keel");
    expect(workflow).toContain("pnpm check:model-metadata");
    expect(workflow).toContain(
      "::error title=Actionable model metadata drift::",
    );
    expect(workflow).toContain(
      "::warning title=Model metadata source failure::",
    );
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
  });
});
