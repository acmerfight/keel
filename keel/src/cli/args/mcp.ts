import {
  type ParseResult,
  parseError,
  parseOk,
  requireSeparatedOptionValue,
} from "./shared.ts";
import type { McpCliArgs } from "./types.ts";

const MCP_ADD_OPTIONS = ["--name", "--allow-private-network"];

function parseMcpAddArgs(args: readonly string[]): ParseResult<McpCliArgs> {
  const url = args[0];
  if (url === undefined || url === "" || url.startsWith("-")) {
    return parseError("Error: mcp add requires <url>.");
  }

  let name: string | undefined;
  let allowPrivateNetwork = false;
  let skipNext = false;
  const namePrefix = "--name=";

  for (const [index, arg] of args.slice(1).entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--name") {
      const parsed = requireSeparatedOptionValue(
        "--name",
        args[index + 2],
        MCP_ADD_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      name = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(namePrefix)) {
      const value = arg.slice(namePrefix.length);
      if (value === "") {
        return parseError("Error: --name requires a value.");
      }
      name = value;
      continue;
    }
    if (arg === "--allow-private-network") {
      allowPrivateNetwork = true;
      continue;
    }
    return parseError(`Error: unknown mcp add option "${arg}"`);
  }

  return parseOk({
    command: "mcp",
    mode: "add",
    url,
    ...(name !== undefined ? { name } : {}),
    allowPrivateNetwork,
  });
}

function parseOptionalServer(
  mode: "doctor" | "status",
  args: readonly string[],
): ParseResult<McpCliArgs> {
  if (args.length > 1) {
    return parseError(`Error: unknown mcp ${mode} option "${args[1]}"`);
  }
  if (args[0]?.startsWith("-") === true) {
    return parseError(`Error: unknown mcp ${mode} option "${args[0]}"`);
  }
  return parseOk({
    command: "mcp",
    mode,
    ...(args[0] !== undefined ? { serverId: args[0] } : {}),
  });
}

export function parseMcpArgs(args: readonly string[]): ParseResult<McpCliArgs> {
  const mode = args[0];
  if (mode === "add") {
    return parseMcpAddArgs(args.slice(1));
  }
  if (mode === "list") {
    if (args.length > 1) {
      return parseError(`Error: unknown mcp list option "${args[1]}"`);
    }
    return parseOk({ command: "mcp", mode: "list" });
  }
  if (mode === "status" || mode === "doctor") {
    return parseOptionalServer(mode, args.slice(1));
  }
  return parseError(
    mode === undefined || mode === ""
      ? "Error: mcp requires a subcommand: add, list, status, or doctor."
      : `Error: unknown mcp subcommand "${mode}"`,
  );
}
