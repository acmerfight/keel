import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args.ts";

describe("MCP CLI args", () => {
  test.each([
    [
      [
        "mcp",
        "add",
        "https://mcp.example/tools",
        "--name",
        "catalog",
        "--allow-private-network",
        "--allow-tool",
        "search",
        "--allow-tool=lookup",
        "--deny-tool",
        "delete",
      ],
      {
        command: "mcp",
        mode: "add",
        url: "https://mcp.example/tools",
        name: "catalog",
        allowPrivateNetwork: true,
        allowTools: ["search", "lookup"],
        denyTools: ["delete"],
      },
    ],
    [
      ["mcp", "add", "https://mcp.example/tools", "--name=catalog"],
      {
        command: "mcp",
        mode: "add",
        url: "https://mcp.example/tools",
        name: "catalog",
        allowPrivateNetwork: false,
        allowTools: [],
        denyTools: [],
      },
    ],
    [
      ["mcp", "add", "https://mcp.example/tools"],
      {
        command: "mcp",
        mode: "add",
        url: "https://mcp.example/tools",
        allowPrivateNetwork: false,
        allowTools: [],
        denyTools: [],
      },
    ],
    [["mcp", "list"], { command: "mcp", mode: "list" }],
    [
      ["mcp", "status", "catalog"],
      { command: "mcp", mode: "status", serverId: "catalog" },
    ],
    [["mcp", "doctor"], { command: "mcp", mode: "doctor" }],
  ])(
    `Given valid MCP command %j,
    When CLI arguments are parsed,
    Then one typed MCP command is produced`,
    (args, expected) => {
      expect(parseCliArgs(args)).toEqual({ ok: true, value: expected });
    },
  );

  test.each([
    [
      ["mcp"],
      "Error: mcp requires a subcommand: add, list, status, or doctor.",
    ],
    [["mcp", "add"], "Error: mcp add requires <url>."],
    [
      ["mcp", "add", "--allow-private-network"],
      "Error: mcp add requires <url>.",
    ],
    [
      ["mcp", "add", "https://mcp.example", "--name"],
      "Error: --name requires a value.",
    ],
    [
      ["mcp", "add", "https://mcp.example", "--name="],
      "Error: --name requires a value.",
    ],
    [
      ["mcp", "add", "https://mcp.example", "--allow-tool"],
      "Error: --allow-tool requires a value.",
    ],
    [
      ["mcp", "add", "https://mcp.example", "--deny-tool="],
      "Error: --deny-tool requires a value.",
    ],
    [
      ["mcp", "add", "https://mcp.example", "--unknown"],
      'Error: unknown mcp add option "--unknown"',
    ],
    [["mcp", "list", "extra"], 'Error: unknown mcp list option "extra"'],
    [["mcp", "status", "--all"], 'Error: unknown mcp status option "--all"'],
    [["mcp", "doctor", "one", "two"], 'Error: unknown mcp doctor option "two"'],
    [["mcp", "login", "catalog"], 'Error: unknown mcp subcommand "login"'],
  ])(
    `Given invalid MCP command %j,
    When CLI arguments are parsed,
    Then parsing fails before configuration or network access`,
    (args, message) => {
      expect(parseCliArgs(args)).toEqual({ ok: false, message });
    },
  );
});
