import { type ParseResult, parseError, parseOk } from "./shared.ts";
import type { SkillsCliArgs } from "./types.ts";

export function parseSkillsArgs(
  args: readonly string[],
): ParseResult<SkillsCliArgs> {
  if (args.length === 0) {
    return parseOk({ command: "skills", mode: "list" });
  }
  if (args.length === 1 && args[0] === "doctor") {
    return parseOk({ command: "skills", mode: "doctor" });
  }
  const action = args[0];
  if (action !== "enable" && action !== "disable") {
    return parseError(`Error: unknown skills option "${action}"`);
  }
  const target = args[1];
  if (target === undefined) {
    return parseError(`Error: skills ${action} requires <skill> or --all.`);
  }
  if (args.length > 2) {
    return parseError(`Error: unknown skills ${action} option "${args[2]}"`);
  }
  if (target.startsWith("--") && target !== "--all") {
    return parseError(`Error: unknown skills ${action} option "${target}"`);
  }
  return parseOk({
    command: "skills",
    mode: "configure",
    action,
    target:
      target === "--all" ? { kind: "all" } : { kind: "skill", lookup: target },
  });
}
