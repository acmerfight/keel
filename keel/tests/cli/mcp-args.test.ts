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
        "--deny-tool=purge",
      ],
      {
        command: "mcp",
        mode: "add",
        url: "https://mcp.example/tools",
        name: "catalog",
        allowPrivateNetwork: true,
        allowTools: ["search", "lookup"],
        denyTools: ["delete", "purge"],
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
    [
      ["mcp", "login", "catalog"],
      {
        command: "mcp",
        mode: "login",
        serverId: "catalog",
        clientRegistration: { kind: "discovered" },
      },
    ],
    [
      [
        "mcp",
        "login",
        "catalog",
        "--client-id",
        "keel-pre-registered",
        "--with-client-secret",
      ],
      {
        command: "mcp",
        mode: "login",
        serverId: "catalog",
        clientRegistration: {
          kind: "pre-registered",
          clientId: "keel-pre-registered",
          withClientSecret: true,
        },
      },
    ],
    [
      ["mcp", "login", "catalog", "--client-id=keel-pre-registered"],
      {
        command: "mcp",
        mode: "login",
        serverId: "catalog",
        clientRegistration: {
          kind: "pre-registered",
          clientId: "keel-pre-registered",
          withClientSecret: false,
        },
      },
    ],
    [
      ["mcp", "logout", "catalog"],
      { command: "mcp", mode: "logout", serverId: "catalog" },
    ],
    [
      ["mcp", "enable", "catalog"],
      { command: "mcp", mode: "enable", serverId: "catalog" },
    ],
    [
      ["mcp", "disable", "catalog"],
      { command: "mcp", mode: "disable", serverId: "catalog" },
    ],
    [
      ["mcp", "remove", "catalog"],
      { command: "mcp", mode: "remove", serverId: "catalog" },
    ],
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
      "Error: mcp requires a subcommand: add, list, status, doctor, login, logout, enable, disable, or remove.",
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
    [["mcp", "login"], "Error: mcp login requires <server>."],
    [["mcp", "logout"], "Error: mcp logout requires <server>."],
    [["mcp", "enable"], "Error: mcp enable requires <server>."],
    [["mcp", "disable"], "Error: mcp disable requires <server>."],
    [["mcp", "remove"], "Error: mcp remove requires <server>."],
    [
      ["mcp", "logout", "catalog", "--all"],
      'Error: unknown mcp logout option "--all"',
    ],
    [
      ["mcp", "enable", "catalog", "--all"],
      'Error: unknown mcp enable option "--all"',
    ],
    [
      ["mcp", "disable", "catalog", "--all"],
      'Error: unknown mcp disable option "--all"',
    ],
    [
      ["mcp", "remove", "catalog", "--all"],
      'Error: unknown mcp remove option "--all"',
    ],
    [
      ["mcp", "login", "catalog", "--unknown"],
      'Error: unknown mcp login option "--unknown"',
    ],
    [
      ["mcp", "login", "catalog", "--client-id"],
      "Error: --client-id requires a value.",
    ],
    [
      ["mcp", "login", "catalog", "--client-id="],
      "Error: --client-id requires a value.",
    ],
    [
      ["mcp", "login", "catalog", "--client-id", "first", "--client-id=second"],
      "Error: --client-id may be specified only once.",
    ],
    [
      ["mcp", "login", "catalog", "--client-id=first", "--client-id", "second"],
      "Error: --client-id may be specified only once.",
    ],
    [
      [
        "mcp",
        "login",
        "catalog",
        "--client-id=client",
        "--with-client-secret",
        "--with-client-secret",
      ],
      "Error: --with-client-secret may be specified only once.",
    ],
    [
      ["mcp", "login", "catalog", "--with-client-secret"],
      "Error: --with-client-secret requires --client-id.",
    ],
  ])(
    `Given invalid MCP command %j,
    When CLI arguments are parsed,
    Then parsing fails before configuration or network access`,
    (args, message) => {
      expect(parseCliArgs(args)).toEqual({ ok: false, message });
    },
  );
});
