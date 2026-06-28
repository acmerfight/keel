import { type BashMode, bashModeFromPolicy } from "../../permissions/bash.ts";
import {
  type ParseResult,
  parseBashPolicy,
  parseError,
  parseForkBeforeMessage,
  parseMaxCost,
  parseModel,
  parseOk,
  parseProviderId,
  parseReportFile,
  parseSkillName,
  requireOptionValue,
} from "./shared.ts";
import type { RunCliArgs } from "./types.ts";

export function parseRunArgs(args: readonly string[]): ParseResult<RunCliArgs> {
  let bashMode: BashMode = "disabled";
  let allowBashOptionSeen = false;
  let bashPolicyOptionSeen = false;
  let maxCostUsd: number | undefined;
  let reportFile: string | undefined;
  let transcriptFile: string | undefined;
  let sessionId: string | undefined;
  let resumeSessionId: string | undefined;
  let forkSessionId: string | undefined;
  let forkBeforeMessage: string | undefined;
  let forkPoints = false;
  let providerId: RunCliArgs["providerId"] | undefined;
  let model: string | undefined;
  let skillName: string | undefined;
  let userMessage: string | undefined;
  const maxCostPrefix = "--max-cost=";
  const reportPrefix = "--report=";
  const transcriptPrefix = "--transcript=";
  const bashPolicyPrefix = "--bash-policy=";
  const sessionPrefix = "--session=";
  const resumePrefix = "--resume=";
  const forkPrefix = "--fork=";
  const forkBeforeMessagePrefix = "--fork-before-message=";
  const providerPrefix = "--provider=";
  const modelPrefix = "--model=";
  const skillPrefix = "--skill=";

  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--allow-bash") {
      if (bashPolicyOptionSeen) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      allowBashOptionSeen = true;
      bashMode = "trusted";
      continue;
    }

    if (arg === "--bash-policy") {
      if (allowBashOptionSeen) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      const parsed = parseBashPolicy(args[index + 1]);
      if (!parsed.ok) return parsed;
      bashPolicyOptionSeen = true;
      bashMode = bashModeFromPolicy(parsed.value);
      skipNext = true;
      continue;
    }

    if (arg.startsWith(bashPolicyPrefix)) {
      if (allowBashOptionSeen) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      const parsed = parseBashPolicy(arg.slice(bashPolicyPrefix.length));
      if (!parsed.ok) return parsed;
      bashPolicyOptionSeen = true;
      bashMode = bashModeFromPolicy(parsed.value);
      continue;
    }

    if (arg === "--provider") {
      const parsed = parseProviderId(args[index + 1]);
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(providerPrefix)) {
      const parsed = parseProviderId(arg.slice(providerPrefix.length));
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      continue;
    }

    if (arg === "--model") {
      const parsed = parseModel(args[index + 1]);
      if (!parsed.ok) return parsed;
      model = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(modelPrefix)) {
      const parsed = parseModel(arg.slice(modelPrefix.length));
      if (!parsed.ok) return parsed;
      model = parsed.value;
      continue;
    }

    if (arg === "--skill") {
      const parsed = parseSkillName(args[index + 1]);
      if (!parsed.ok) return parsed;
      skillName = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(skillPrefix)) {
      const parsed = parseSkillName(arg.slice(skillPrefix.length));
      if (!parsed.ok) return parsed;
      skillName = parsed.value;
      continue;
    }

    if (arg === "--max-cost") {
      const parsed = parseMaxCost(args[index + 1]);
      if (!parsed.ok) return parsed;
      maxCostUsd = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(maxCostPrefix)) {
      const parsed = parseMaxCost(arg.slice(maxCostPrefix.length));
      if (!parsed.ok) return parsed;
      maxCostUsd = parsed.value;
      continue;
    }

    if (arg === "--report") {
      const parsed = parseReportFile(args[index + 1]);
      if (!parsed.ok) return parsed;
      reportFile = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(reportPrefix)) {
      const parsed = parseReportFile(arg.slice(reportPrefix.length));
      if (!parsed.ok) return parsed;
      reportFile = parsed.value;
      continue;
    }

    if (arg === "--transcript") {
      const parsed = requireOptionValue("--transcript", args[index + 1]);
      if (!parsed.ok) return parsed;
      transcriptFile = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(transcriptPrefix)) {
      const parsed = requireOptionValue(
        "--transcript",
        arg.slice(transcriptPrefix.length),
      );
      if (!parsed.ok) return parsed;
      transcriptFile = parsed.value;
      continue;
    }

    if (arg === "--session") {
      const parsed = requireOptionValue("--session", args[index + 1]);
      if (!parsed.ok) return parsed;
      sessionId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(sessionPrefix)) {
      const parsed = requireOptionValue(
        "--session",
        arg.slice(sessionPrefix.length),
      );
      if (!parsed.ok) return parsed;
      sessionId = parsed.value;
      continue;
    }

    if (arg === "--resume") {
      const parsed = requireOptionValue("--resume", args[index + 1]);
      if (!parsed.ok) return parsed;
      resumeSessionId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(resumePrefix)) {
      const parsed = requireOptionValue(
        "--resume",
        arg.slice(resumePrefix.length),
      );
      if (!parsed.ok) return parsed;
      resumeSessionId = parsed.value;
      continue;
    }

    if (arg === "--fork") {
      const parsed = requireOptionValue("--fork", args[index + 1]);
      if (!parsed.ok) return parsed;
      forkSessionId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(forkPrefix)) {
      const parsed = requireOptionValue("--fork", arg.slice(forkPrefix.length));
      if (!parsed.ok) return parsed;
      forkSessionId = parsed.value;
      continue;
    }

    if (arg === "--fork-before-message") {
      const parsed = parseForkBeforeMessage(args[index + 1]);
      if (!parsed.ok) return parsed;
      forkBeforeMessage = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(forkBeforeMessagePrefix)) {
      const parsed = parseForkBeforeMessage(
        arg.slice(forkBeforeMessagePrefix.length),
      );
      if (!parsed.ok) return parsed;
      forkBeforeMessage = parsed.value;
      continue;
    }

    if (arg === "--fork-points") {
      forkPoints = true;
      continue;
    }

    if (arg === "--") {
      const message = args.slice(index + 1).join(" ");
      if (message !== "") {
        userMessage = message;
      }
      break;
    }

    if (arg.startsWith("-")) {
      return parseError(`Error: unknown option "${arg}"`, "unknownOption");
    }

    userMessage = args.slice(index).join(" ");
    break;
  }

  if (sessionId !== undefined && resumeSessionId !== undefined) {
    return parseError("Error: --session cannot be combined with --resume.");
  }
  if (forkPoints && resumeSessionId === undefined) {
    return parseError("Error: --fork-points requires --resume <id>.");
  }
  if (forkPoints && forkSessionId !== undefined) {
    return parseError("Error: --fork-points cannot be combined with --fork.");
  }
  if (forkPoints && forkBeforeMessage !== undefined) {
    return parseError(
      "Error: --fork-points cannot be combined with --fork-before-message.",
    );
  }
  if (forkPoints && userMessage !== undefined) {
    return parseError(
      "Error: --fork-points cannot be combined with a message.",
    );
  }
  if (forkPoints && transcriptFile !== undefined) {
    return parseError(
      "Error: --fork-points cannot be combined with --transcript.",
    );
  }
  if (
    forkBeforeMessage !== undefined &&
    (resumeSessionId === undefined || forkSessionId === undefined)
  ) {
    return parseError(
      "Error: --fork-before-message requires --resume <id> --fork <new-id>.",
    );
  }
  if (forkSessionId !== undefined && resumeSessionId === undefined) {
    return parseError("Error: --fork requires --resume <id>.");
  }

  return parseOk({
    command: "run",
    bashMode,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
    ...(transcriptFile !== undefined ? { transcriptFile } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(forkSessionId !== undefined ? { forkSessionId } : {}),
    ...(forkBeforeMessage !== undefined ? { forkBeforeMessage } : {}),
    ...(forkPoints ? { forkPoints } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(skillName !== undefined ? { skillName } : {}),
  });
}
