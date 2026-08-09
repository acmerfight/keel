import { describe, expect, test } from "vitest";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";

describe("Interactive /agents command", () => {
  test(`Given supported agent-history command forms,
    When they are parsed,
    Then the command union preserves the requested action and selector`, () => {
    expect(parseInteractiveCommand("/agents")).toEqual({
      kind: "agents",
      action: "list",
    });
    expect(parseInteractiveCommand("/agents show 2")).toEqual({
      kind: "agents",
      action: "show",
      selector: "2",
    });
    expect(parseInteractiveCommand("/agents transcript agent-123")).toEqual({
      kind: "agents",
      action: "transcript",
      selector: "agent-123",
    });
  });

  test(`Given an incomplete or over-specified agent-history command,
    When it is parsed,
    Then it fails as a command instead of reaching the model`, () => {
    for (const input of [
      "/agents show",
      "/agents transcript",
      "/agents show 1 extra",
      "/agents unknown 1",
    ]) {
      expect(parseInteractiveCommand(input)).toEqual({
        kind: "invalid",
        message:
          "Error: usage is /agents, /agents show <id|index>, or /agents transcript <id|index>.",
      });
    }
  });
});
