import { type ParseResult, parseError, parseOk } from "./shared.ts";
import type { MemoryCliArgs } from "./types.ts";

export function parseMemoryArgs(
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  const subcommand = args[0];
  if (subcommand === "--help") {
    return parseOk({ command: "memory", mode: "help" });
  }
  if (subcommand === "add") {
    if (args[1] === undefined || args[1].trim() === "") {
      return parseError("Error: memory add requires <durable-fact>.");
    }
    if (args.length > 2) {
      return parseError(`Error: unknown memory add option "${args[2]}"`);
    }
    return parseOk({ command: "memory", mode: "add", text: args[1] });
  }
  if (subcommand === "list") {
    if (args.length > 1) {
      return parseError(`Error: unknown memory list option "${args[1]}"`);
    }
    return parseOk({ command: "memory", mode: "list" });
  }
  if (subcommand === "forget") {
    if (args[1] === undefined || args[1] === "") {
      return parseError("Error: memory forget requires <id>.");
    }
    if (args.length > 2) {
      return parseError(`Error: unknown memory forget option "${args[2]}"`);
    }
    return parseOk({ command: "memory", mode: "forget", id: args[1] });
  }
  if (subcommand === "clear") {
    if (args.length === 1) {
      return parseOk({ command: "memory", mode: "clear", confirmed: false });
    }
    if (args.length === 2 && args[1] === "--yes") {
      return parseOk({ command: "memory", mode: "clear", confirmed: true });
    }
    return parseError(`Error: unknown memory clear option "${args[1]}"`);
  }
  return parseError(
    subcommand === undefined
      ? "Error: memory requires a subcommand: add, list, forget, or clear."
      : `Error: unknown memory subcommand "${subcommand}"`,
  );
}
