import { describe, expect, test } from "vitest";
import { buildAgentSystemPrompt } from "../../src/agent/prompt.ts";

describe("Agent System Prompt", () => {
  test(`Given a workspace and platform,
    When the agent's system prompt is built,
    Then it presents keel as a coding agent bound to that workspace with read-before-edit and search-first discipline`, () => {
    // Given
    const workspace = "/tmp/project-xyz";
    const platform = "linux";

    // When
    const prompt = buildAgentSystemPrompt({ workspace, platform });
    const lower = prompt.toLowerCase();

    // Then — coding-agent identity, not a generic assistant
    expect(prompt).not.toContain("You are a helpful assistant");
    expect(lower).toContain("keel");
    expect(lower).toContain("coding agent");

    // Then — the workspace and platform are injected as environment
    expect(prompt).toContain(workspace);
    expect(prompt).toContain(platform);

    // Then — cross-cutting tool discipline the schemas cannot express
    expect(lower).toContain("grep");
    expect(lower).toMatch(/read[\s\S]*before[\s\S]*edit/);
    expect(lower).toContain("file_path:line_number");
  });
});
