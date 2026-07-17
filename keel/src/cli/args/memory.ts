import {
  type ParseResult,
  parseError,
  parseMaxCost,
  parseModel,
  parseOk,
  parseProviderId,
} from "./shared.ts";
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

function candidateRequiredId(
  subcommand: "show" | "reject",
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  if (args[1] === undefined || args[1] === "") {
    return parseError(
      `Error: memory candidates ${subcommand} requires <candidate-id>.`,
    );
  }
  if (args.length > 2) {
    return parseError(
      `Error: unknown memory candidates ${subcommand} option "${args[2]}"`,
    );
  }
  return parseOk({
    command: "memory",
    mode: `candidates-${subcommand}`,
    id: args[1],
  });
}

function parseCandidatePurge(
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  const id = args[1];
  if (id === undefined || id === "") {
    return parseError(
      "Error: memory candidates purge requires <candidate-id>.",
    );
  }
  if (args.length === 2) {
    return parseOk({
      command: "memory",
      mode: "candidates-purge",
      id,
      purgeMemoryId: null,
    });
  }
  if (args[2] !== "--purge-memory") {
    return parseError(
      `Error: unknown memory candidates purge option "${args[2]}"`,
    );
  }
  const memoryId = args[3];
  if (memoryId === undefined || memoryId === "") {
    return parseError(
      "Error: memory candidates purge --purge-memory requires <memory-id>.",
    );
  }
  if (args.length > 4) {
    return parseError(
      `Error: unknown memory candidates purge option "${args[4]}"`,
    );
  }
  return parseOk({
    command: "memory",
    mode: "candidates-purge",
    id,
    purgeMemoryId: memoryId,
  });
}

function parseCandidateExtract(
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  const sessionId = args[1];
  if (sessionId === undefined || sessionId === "") {
    return parseError(
      "Error: memory candidates extract requires <session-id> --max-cost <usd>.",
    );
  }
  let maxCostUsd: number | null = null;
  let providerId: Extract<
    MemoryCliArgs,
    { readonly mode: "candidates-extract" }
  >["providerId"] = null;
  let model: string | null = null;
  let retry = false;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--retry") {
      if (retry) {
        return parseError(
          'Error: memory candidates extract option "--retry" was provided more than once.',
        );
      }
      retry = true;
      continue;
    }
    const value = args[index + 1];
    if (option === "--max-cost") {
      if (maxCostUsd !== null) {
        return parseError(
          'Error: memory candidates extract option "--max-cost" was provided more than once.',
        );
      }
      const parsed = parseMaxCost(value);
      if (!parsed.ok) return parsed;
      maxCostUsd = parsed.value;
      index += 1;
      continue;
    }
    if (option === "--provider") {
      if (providerId !== null) {
        return parseError(
          'Error: memory candidates extract option "--provider" was provided more than once.',
        );
      }
      const parsed = parseProviderId(value);
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      index += 1;
      continue;
    }
    if (option === "--model") {
      if (model !== null) {
        return parseError(
          'Error: memory candidates extract option "--model" was provided more than once.',
        );
      }
      const parsed = parseModel(value);
      if (!parsed.ok) return parsed;
      model = parsed.value;
      index += 1;
      continue;
    }
    return parseError(
      `Error: unknown memory candidates extract option "${option}"`,
    );
  }
  if (maxCostUsd === null) {
    return parseError(
      "Error: memory candidates extract requires --max-cost <usd>.",
    );
  }
  return parseOk({
    command: "memory",
    mode: "candidates-extract",
    sessionId,
    maxCostUsd,
    providerId,
    model,
    retry,
  });
}

function parseCandidateApprove(
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  const id = args[1];
  if (id === undefined || id === "") {
    return parseError(
      "Error: memory candidates approve requires <candidate-id>.",
    );
  }
  if (args.length === 2) {
    return parseOk({
      command: "memory",
      mode: "candidates-approve",
      id,
      conflictResolution: { type: "none" },
    });
  }
  if (args[2] === "--keep" && args.length === 3) {
    return parseOk({
      command: "memory",
      mode: "candidates-approve",
      id,
      conflictResolution: { type: "keep" },
    });
  }
  if (args[2] === "--supersede" && args[3] !== undefined && args.length === 4) {
    return parseOk({
      command: "memory",
      mode: "candidates-approve",
      id,
      conflictResolution: { type: "supersede", memoryId: args[3] },
    });
  }
  if (args.includes("--keep") && args.includes("--supersede")) {
    return parseError(
      "Error: memory candidates approve accepts only one conflict resolution: --keep or --supersede <memory-id>.",
    );
  }
  return parseError(
    `Error: unknown memory candidates approve option "${args[2]}"`,
  );
}

function parseCandidateClear(
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  let confirmed = false;
  let purge = false;
  let purgeLinkedMemories = false;
  for (const option of args.slice(1)) {
    if (option === "--yes" && !confirmed) confirmed = true;
    else if (option === "--purge" && !purge) purge = true;
    else if (option === "--purge-memories" && !purgeLinkedMemories) {
      purgeLinkedMemories = true;
    } else
      return parseError(
        `Error: unknown memory candidates clear option "${option}"`,
      );
  }
  if (purgeLinkedMemories && !purge) {
    return parseError(
      'Error: memory candidates clear --purge-memories requires "--purge".',
    );
  }
  return parseOk({
    command: "memory",
    mode: "candidates-clear",
    confirmed,
    purge,
    purgeLinkedMemories,
  });
}

function parseCandidatesArgs(
  args: readonly string[],
): ParseResult<MemoryCliArgs> {
  const subcommand = args[0];
  if (subcommand === "extract") return parseCandidateExtract(args);
  if (subcommand === "list") {
    if (args.length > 1) {
      return parseError(
        `Error: unknown memory candidates list option "${args[1]}"`,
      );
    }
    return parseOk({ command: "memory", mode: "candidates-list" });
  }
  if (subcommand === "show" || subcommand === "reject") {
    return candidateRequiredId(subcommand, args);
  }
  if (subcommand === "purge") return parseCandidatePurge(args);
  if (subcommand === "edit") {
    if (
      args[1] === undefined ||
      args[1] === "" ||
      args[2] === undefined ||
      args[2].trim() === ""
    ) {
      return parseError(
        "Error: memory candidates edit requires <candidate-id> <replacement>.",
      );
    }
    if (args.length > 3) {
      return parseError(
        `Error: unknown memory candidates edit option "${args[3]}"`,
      );
    }
    return parseOk({
      command: "memory",
      mode: "candidates-edit",
      id: args[1],
      text: args[2],
    });
  }
  if (subcommand === "approve") return parseCandidateApprove(args);
  if (subcommand === "clear") return parseCandidateClear(args);
  return parseError(
    subcommand === undefined
      ? "Error: memory candidates requires a subcommand: extract, list, show, edit, approve, reject, purge, or clear."
      : `Error: unknown memory candidates subcommand "${subcommand}"`,
  );
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
  if (subcommand === "candidates") {
    return parseCandidatesArgs(args.slice(1));
  }
  return parseError(
    subcommand === undefined
      ? "Error: memory requires a subcommand: add, list, show, update, review, verify, forget, purge, clear, or candidates."
      : `Error: unknown memory subcommand "${subcommand}"`,
  );
}
