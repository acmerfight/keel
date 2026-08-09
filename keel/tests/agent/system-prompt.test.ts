import { describe, expect, test } from "vitest";
import {
  appendDelegationToSystemPrompt,
  buildAgentSystemPrompt,
  buildReadOnlySubagentSystemPrompt,
} from "../../src/agent/prompt.ts";

describe("Agent System Prompt", () => {
  test(`Given a bounded child handoff can truncate verbose evidence,
    When main and child delegation prompts are built,
    Then both agents preserve named facts while keeping the handoff compact`, () => {
    const mainPrompt = appendDelegationToSystemPrompt("base");
    const childPrompt = buildReadOnlySubagentSystemPrompt({
      workspace: "/tmp/project",
      platform: "linux",
      focusPaths: ["src"],
    });

    expect(mainPrompt).toContain(
      "Do not ask the child to paste bulk source, logs, or repeated evidence",
    );
    expect(mainPrompt).toContain(
      "Call delegate as the only tool in that assistant turn",
    );
    expect(mainPrompt).toContain(
      "Change a reported fact only when direct evidence for that same fact contradicts it",
    );
    expect(mainPrompt).toContain(
      "use evidence that defines that field, not a related observation",
    );
    expect(mainPrompt).toContain(
      "do not reread child-covered resources merely to reconfirm a supported fact",
    );
    expect(childPrompt).toContain(
      "Start the final message with the direct answer or requested structured output",
    );
    expect(childPrompt).toContain(
      "Keep the entire final message under 4,000 characters",
    );
    expect(childPrompt).toContain(
      "Do not paste bulk source, logs, CSV rows, or repeated evidence",
    );
    expect(childPrompt).toContain(
      "Keep configured or declared values distinct from observations, examples, and sampled values",
    );
  });

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

  test(`Given root project instructions are available,
    When the agent's system prompt is built,
    Then it includes the project instructions as lower-priority workspace guidance`, () => {
    // Given
    const workspace = "/tmp/project-with-agents";
    const projectInstructions = {
      relativePath: "AGENTS.md",
      content:
        "Use pnpm for package scripts.\nWrite BDD tests before production code.",
    };

    // When
    const prompt = buildAgentSystemPrompt({
      workspace,
      platform: "linux",
      projectInstructions,
    });

    // Then
    expect(prompt).toContain("Project instructions from AGENTS.md");
    expect(prompt).toContain("> Use pnpm for package scripts.");
    expect(prompt).toContain("> Write BDD tests before production code.");
    expect(prompt).toMatch(
      /Project instructions[\s\S]*lower priority[\s\S]*user request/i,
    );
  });

  test(`Given a user-selected workflow skill is available,
    When the agent's system prompt is built,
    Then it includes the skill as explicit workflow guidance for this run`, () => {
    // Given
    const workflowSkill = {
      id: "repo:test:review",
      packageId: "repo:test:review",
      digest: "digest",
      qualifiedName: "repo:review",
      scope: "repo" as const,
      relativePath: ".agents/skills/review/SKILL.md",
      name: "review",
      resourcePaths: ["references/checklist.md", "scripts/verify.ts"],
      content:
        "Read the PR comments first.\nFollow the project testing rules before reporting.",
    };

    // When
    const prompt = buildAgentSystemPrompt({
      workspace: "/tmp/project-with-skill",
      platform: "linux",
      workflowSkills: [workflowSkill],
    });

    // Then
    expect(prompt).toContain(
      "Workflow skill repo:review from .agents/skills/review/SKILL.md",
    );
    expect(prompt).toContain("Skill base directory: .agents/skills/review");
    expect(prompt).toContain(
      "Relative paths in this workflow skill resolve from that directory.",
    );
    expect(prompt).toContain(
      "Read advertised text resources with skill_resource using this skill's exact qualified name",
    );
    expect(prompt).toContain(
      "Binary assets cannot be read as text with skill_resource",
    );
    expect(prompt).toContain("- references/checklist.md");
    expect(prompt).toContain("- scripts/verify.ts");
    expect(prompt).toContain("> Read the PR comments first.");
    expect(prompt).toContain(
      "> Follow the project testing rules before reporting.",
    );
    expect(prompt).toMatch(
      /Workflow skill[\s\S]*active for the current session[\s\S]*current user request/i,
    );
  });

  test(`Given restored workflow skill metadata lacks a parent directory,
    When the agent's system prompt is built,
    Then the skill base directory falls back to the workspace root`, () => {
    // Given
    const workflowSkill = {
      id: "repo:test:review",
      packageId: "repo:test:review",
      digest: "digest",
      qualifiedName: "repo:review",
      scope: "repo" as const,
      relativePath: "SKILL.md",
      name: "review",
      resourcePaths: [],
      content: "Read the restored workflow body.",
    };

    // When
    const prompt = buildAgentSystemPrompt({
      workspace: "/tmp/project-with-restored-skill",
      platform: "linux",
      workflowSkills: [workflowSkill],
    });

    // Then
    expect(prompt).toContain("Skill base directory: .");
    expect(prompt).toContain(
      "Available skill resource paths: none discovered under references/, scripts/, or assets/.",
    );
    expect(prompt).toContain("> Read the restored workflow body.");
  });

  test(`Given a workspace and platform,
    When the agent's system prompt is built,
    Then it includes structured error-handling guidance that tells the model how to recover from tool failures`, () => {
    // Given / When
    const prompt = buildAgentSystemPrompt({
      workspace: "/tmp/project",
      platform: "linux",
    });
    const lower = prompt.toLowerCase();

    // Then — error handling contract
    expect(lower).toContain("tool failed");
    expect(lower).toContain("recovery");
    expect(lower).toMatch(/do not retry.*same|never retry.*same/);
  });

  test(`Given a workspace and platform,
    When the agent's system prompt is built,
    Then it includes edit workflow discipline requiring read before edit`, () => {
    // Given / When
    const prompt = buildAgentSystemPrompt({
      workspace: "/tmp/project",
      platform: "linux",
    });
    const lower = prompt.toLowerCase();

    // Then — edit workflow
    expect(lower).toMatch(/read.*file.*before.*edit/);
    expect(lower).toMatch(/oldstring|old.?string/);
  });

  test(`Given a workspace and platform,
    When the agent's system prompt is built,
    Then it includes verification expectations for completed changes`, () => {
    // Given / When
    const prompt = buildAgentSystemPrompt({
      workspace: "/tmp/project",
      platform: "linux",
    });
    const lower = prompt.toLowerCase();

    // Then — verification after changes
    expect(lower).toMatch(/verify|confirm|check/);
    expect(lower).toMatch(/after.*change|after.*edit/);
  });

  test(`Given a workspace and platform,
    When the agent's system prompt is built,
    Then the total prompt stays within a reasonable token budget`, () => {
    // Given / When
    const prompt = buildAgentSystemPrompt({
      workspace: "/tmp/project",
      platform: "linux",
    });

    // Then — rough word count as proxy for ~1000 token budget
    const wordCount = prompt.split(/\s+/).length;
    expect(wordCount).toBeLessThan(800);
    expect(wordCount).toBeGreaterThan(100);
  });
});
