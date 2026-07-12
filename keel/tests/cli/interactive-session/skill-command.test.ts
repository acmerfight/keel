import { describe, expect, test } from "vitest";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";

describe("interactive Skill commands", () => {
  test(`Given each supported Skill command shape,
    When it is parsed,
    Then lifecycle actions and task arguments remain unambiguous`, () => {
    expect(parseInteractiveCommand("/skill")).toEqual({
      kind: "skill",
      action: "active",
    });
    expect(parseInteractiveCommand("/skill deactivate repo:review")).toEqual({
      kind: "skill",
      action: "deactivate",
      lookup: "repo:review",
    });
    expect(parseInteractiveCommand("/skill reload repo:review")).toEqual({
      kind: "skill",
      action: "reload",
      lookup: "repo:review",
    });
    expect(parseInteractiveCommand("/skill repo:review")).toEqual({
      kind: "skill",
      action: "activate",
      lookup: "repo:review",
    });
    expect(
      parseInteractiveCommand("/skill repo:review inspect PR 430"),
    ).toEqual({
      kind: "skill",
      action: "activate",
      lookup: "repo:review",
      arguments: "inspect PR 430",
    });
    expect(parseInteractiveCommand("/skills active")).toEqual({
      kind: "skill",
      action: "active",
    });
  });

  test(`Given missing or extra lifecycle arguments,
    When a Skill command is parsed,
    Then it returns actionable invalid-command guidance`, () => {
    for (const input of [
      "/skill deactivate",
      "/skill reload repo:review extra",
    ]) {
      expect(parseInteractiveCommand(input)).toEqual({
        kind: "invalid",
        message: expect.stringContaining(
          "requires one workflow skill identity",
        ),
      });
    }
    for (const input of ["/skills", "/skills review"]) {
      expect(parseInteractiveCommand(input)).toEqual({
        kind: "invalid",
        message: "Error: use /skills active to list active workflow skills.",
      });
    }
  });
});
