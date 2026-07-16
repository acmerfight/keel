import { type ParseResult, parseError, parseOk } from "./shared.ts";
import type { MemoryCliArgs } from "./types.ts";

interface MemoryScheduleOptions {
  readonly reviewAfter: string | null;
  readonly expiresAt: string | null;
}

function parseScheduleOptions(
  command: "add" | "update",
  args: readonly string[],
): ParseResult<MemoryScheduleOptions> {
  let reviewAfter: string | undefined;
  let expiresAt: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--review-after" && option !== "--expires-at") {
      return parseError(`Error: unknown memory ${command} option "${option}"`);
    }
    if (value === undefined || value === "") {
      return parseError(
        `Error: memory ${command} ${option} requires <timestamp>.`,
      );
    }
    if (option === "--review-after") {
      if (reviewAfter !== undefined) {
        return parseError(
          `Error: memory ${command} option "--review-after" was provided more than once.`,
        );
      }
      reviewAfter = value;
    } else {
      if (expiresAt !== undefined) {
        return parseError(
          `Error: memory ${command} option "--expires-at" was provided more than once.`,
        );
      }
      expiresAt = value;
    }
  }
  return parseOk({
    reviewAfter: reviewAfter ?? null,
    expiresAt: expiresAt ?? null,
  });
}

function requiredId(
  subcommand: "show" | "verify" | "forget" | "purge",
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  if (args[1] === undefined || args[1] === "") {
    return parseError(`Error: memory ${subcommand} requires <id>.`);
  }
  if (args.length > 2) {
    return parseError(
      `Error: unknown memory ${subcommand} option "${args[2]}"`,
    );
  }
  return parseOk({ command: "memory", mode: subcommand, id: args[1] });
}

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
    const schedule = parseScheduleOptions("add", args.slice(2));
    if (!schedule.ok) return schedule;
    return parseOk({
      command: "memory",
      mode: "add",
      text: args[1],
      ...schedule.value,
    });
  }
  if (subcommand === "list") {
    if (args.length === 1) {
      return parseOk({ command: "memory", mode: "list", all: false });
    }
    if (args.length === 2 && args[1] === "--all") {
      return parseOk({ command: "memory", mode: "list", all: true });
    }
    if (args.length > 1) {
      return parseError(`Error: unknown memory list option "${args[1]}"`);
    }
  }
  if (subcommand === "show") return requiredId("show", args);
  if (subcommand === "update") {
    if (
      args[1] === undefined ||
      args[1] === "" ||
      args[2] === undefined ||
      args[2].trim() === ""
    ) {
      return parseError("Error: memory update requires <id> <replacement>.");
    }
    const schedule = parseScheduleOptions("update", args.slice(3));
    if (!schedule.ok) return schedule;
    return parseOk({
      command: "memory",
      mode: "update",
      id: args[1],
      text: args[2],
      ...schedule.value,
    });
  }
  if (subcommand === "review") {
    if (args.length === 1) {
      return parseOk({ command: "memory", mode: "review", due: false });
    }
    if (args.length === 2 && args[1] === "--due") {
      return parseOk({ command: "memory", mode: "review", due: true });
    }
    return parseError(`Error: unknown memory review option "${args[1]}"`);
  }
  if (subcommand === "verify") return requiredId("verify", args);
  if (subcommand === "forget") return requiredId("forget", args);
  if (subcommand === "purge") return requiredId("purge", args);
  if (subcommand === "clear") {
    let confirmed = false;
    let purge = false;
    for (const option of args.slice(1)) {
      if (option === "--yes" && !confirmed) {
        confirmed = true;
      } else if (option === "--purge" && !purge) {
        purge = true;
      } else {
        return parseError(`Error: unknown memory clear option "${option}"`);
      }
    }
    return parseOk({ command: "memory", mode: "clear", confirmed, purge });
  }
  return parseError(
    subcommand === undefined
      ? "Error: memory requires a subcommand: add, list, show, update, review, verify, forget, purge, or clear."
      : `Error: unknown memory subcommand "${subcommand}"`,
  );
}
