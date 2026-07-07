import { type ParseResult, parseError, parseOk } from "./shared.ts";
import type { ApprovalsCliArgs } from "./types.ts";

function parseApprovalIndex(raw: string | undefined): ParseResult<number> {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) {
    return parseError("Error: approvals revoke requires a positive index.");
  }
  const index = Number(raw);
  if (!Number.isSafeInteger(index)) {
    return parseError("Error: approvals revoke requires a positive index.");
  }
  return parseOk(index);
}

export function parseApprovalsArgs(
  args: readonly string[],
): ParseResult<ApprovalsCliArgs> {
  const subcommand = args[0];
  if (subcommand === undefined) {
    return parseOk({ command: "approvals", mode: "list" });
  }
  if (subcommand === "clear") {
    if (args.length > 1) {
      return parseError(`Error: unknown approvals clear option "${args[1]}"`);
    }
    return parseOk({ command: "approvals", mode: "clear" });
  }
  if (subcommand === "revoke") {
    const parsed = parseApprovalIndex(args[1]);
    if (!parsed.ok) return parsed;
    if (args.length > 2) {
      return parseError(`Error: unknown approvals revoke option "${args[2]}"`);
    }
    return parseOk({
      command: "approvals",
      mode: "revoke",
      index: parsed.value,
    });
  }
  return parseError(`Error: unknown approvals option "${subcommand}"`);
}
