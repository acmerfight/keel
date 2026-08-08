import { type BashMode, bashModeFromPolicy } from "../../permissions/bash.ts";
import {
  isRecognizedOptionToken,
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
  requireSeparatedOptionValue,
} from "./shared.ts";
import type { InteractiveSessionCliIntent, RunCliArgs } from "./types.ts";

const RUN_OPTIONS = [
  "--allow-bash",
  "--bash-policy",
  "--provider",
  "--model",
  "--skill",
  "--no-skills",
  "--experimental-agents",
  "--max-cost",
  "--report",
  "--transcript",
  "--ephemeral",
  "--no-memory",
  "--session",
  "--resume",
  "--pick",
  "--fork",
  "--fork-before-message",
  "--fork-points",
];

export function parseRunArgs(args: readonly string[]): ParseResult<RunCliArgs> {
  let bashMode: BashMode = "disabled";
  let allowBashOptionSeen = false;
  let bashPolicyOptionSeen = false;
  let maxCostUsd: number | undefined;
  let reportFile: string | undefined;
  let transcriptFile: string | undefined;
  let ephemeral = false;
  let memoryEnabled = true;
  let sessionId: string | undefined;
  let resumeSession:
    | { readonly kind: "id"; readonly sessionId: string }
    | { readonly kind: "latest" }
    | undefined;
  let resumePick = false;
  let forkSessionId: string | undefined;
  let forkBeforeMessage: string | undefined;
  let forkPoints = false;
  let providerId: RunCliArgs["providerId"] | undefined;
  let model: string | undefined;
  let skillsEnabled = true;
  let experimentalAgents = false;
  const skillNames: string[] = [];
  let userMessage: string | undefined;
  let positionalMessagePresent = false;
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
      const parsed = requireSeparatedOptionValue(
        "--model",
        args[index + 1],
        RUN_OPTIONS,
      );
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
      const parsed = requireSeparatedOptionValue(
        "--skill",
        args[index + 1],
        RUN_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      skillNames.push(parsed.value);
      skipNext = true;
      continue;
    }

    if (arg === "--no-skills") {
      skillsEnabled = false;
      continue;
    }

    if (arg === "--experimental-agents") {
      experimentalAgents = true;
      continue;
    }

    if (arg.startsWith(skillPrefix)) {
      const parsed = parseSkillName(arg.slice(skillPrefix.length));
      if (!parsed.ok) return parsed;
      skillNames.push(parsed.value);
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
      const nextArg = args[index + 1];
      const parsed =
        nextArg === undefined || nextArg === ""
          ? parseReportFile(nextArg)
          : requireSeparatedOptionValue("--report", nextArg, RUN_OPTIONS);
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
      const parsed = requireSeparatedOptionValue(
        "--transcript",
        args[index + 1],
        RUN_OPTIONS,
      );
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

    if (arg === "--ephemeral") {
      ephemeral = true;
      continue;
    }

    if (arg === "--no-memory") {
      memoryEnabled = false;
      continue;
    }

    if (arg === "--session") {
      const parsed = requireSeparatedOptionValue(
        "--session",
        args[index + 1],
        RUN_OPTIONS,
      );
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
      const nextArg = args[index + 1];
      if (
        nextArg === undefined ||
        isRecognizedOptionToken(nextArg, RUN_OPTIONS)
      ) {
        resumeSession = { kind: "latest" };
        continue;
      }
      const parsed = requireSeparatedOptionValue(
        "--resume",
        nextArg,
        RUN_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      resumeSession = { kind: "id", sessionId: parsed.value };
      skipNext = true;
      continue;
    }

    if (arg.startsWith(resumePrefix)) {
      const parsed = requireOptionValue(
        "--resume",
        arg.slice(resumePrefix.length),
      );
      if (!parsed.ok) return parsed;
      resumeSession = { kind: "id", sessionId: parsed.value };
      continue;
    }

    if (arg === "--pick") {
      resumePick = true;
      continue;
    }

    if (arg === "--fork") {
      const parsed = requireSeparatedOptionValue(
        "--fork",
        args[index + 1],
        RUN_OPTIONS,
      );
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
      const parsed = requireSeparatedOptionValue(
        "--fork-before-message",
        args[index + 1],
        RUN_OPTIONS,
      );
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
        positionalMessagePresent = true;
      }
      break;
    }

    if (arg.startsWith("-")) {
      return parseError(`Error: unknown option "${arg}"`, "unknownOption");
    }

    const message = args.slice(index).join(" ");
    positionalMessagePresent = true;
    if (message !== "") {
      userMessage = message;
    }
    break;
  }

  if (sessionId !== undefined && resumeSession !== undefined) {
    return parseError("Error: --session cannot be combined with --resume.");
  }
  if (
    ephemeral &&
    (sessionId !== undefined ||
      resumeSession !== undefined ||
      forkSessionId !== undefined ||
      forkBeforeMessage !== undefined ||
      forkPoints)
  ) {
    return parseError(
      "Error: --ephemeral cannot be combined with --session, --resume, --fork, --fork-before-message, or --fork-points.",
    );
  }
  if (resumePick && resumeSession === undefined) {
    return parseError("Error: --pick requires --resume.");
  }
  if (resumePick && resumeSession?.kind === "id") {
    return parseError(
      "Error: --resume --pick requires --resume without a session id.",
    );
  }
  if (resumePick && forkSessionId !== undefined) {
    return parseError("Error: --resume --pick cannot be combined with --fork.");
  }
  if (resumePick && forkPoints) {
    return parseError(
      "Error: --resume --pick cannot be combined with --fork-points.",
    );
  }
  if (resumePick && forkBeforeMessage !== undefined) {
    return parseError(
      "Error: --resume --pick cannot be combined with --fork-before-message.",
    );
  }
  if (resumePick && positionalMessagePresent) {
    return parseError(
      "Error: --resume --pick cannot be combined with a message.",
    );
  }
  if (resumePick && transcriptFile !== undefined) {
    return parseError(
      "Error: --resume --pick cannot be combined with --transcript.",
    );
  }
  const hasResumeSessionId = resumeSession?.kind === "id";
  if (forkPoints && resumeSession?.kind !== "id") {
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
  if (forkPoints && positionalMessagePresent) {
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
    (!hasResumeSessionId || forkSessionId === undefined)
  ) {
    return parseError(
      "Error: --fork-before-message requires --resume <id> --fork <new-id>.",
    );
  }
  if (forkSessionId !== undefined && !hasResumeSessionId) {
    return parseError("Error: --fork requires --resume <id>.");
  }
  if (!skillsEnabled && skillNames.length > 0) {
    return parseError("Error: --no-skills cannot be combined with --skill.");
  }
  if (experimentalAgents && maxCostUsd === undefined) {
    return parseError(
      "Error: --experimental-agents requires --max-cost <usd> so the root and child share a bounded budget.",
    );
  }
  if (experimentalAgents && userMessage === undefined) {
    return parseError(
      "Error: --experimental-agents currently supports one-shot runs with a message only.",
    );
  }

  if (
    positionalMessagePresent &&
    (sessionId !== undefined || resumeSession !== undefined)
  ) {
    return parseError(
      "Error: --session and --resume are only supported for interactive sessions.",
    );
  }
  if (positionalMessagePresent && ephemeral) {
    return parseError(
      "Error: --ephemeral is only supported for interactive sessions.",
    );
  }
  if (userMessage === undefined && transcriptFile !== undefined) {
    return parseError(
      "Error: --transcript is only supported for one-shot runs.",
    );
  }
  const forkPointsSessionId =
    forkPoints && resumeSession?.kind === "id" ? resumeSession.sessionId : null;

  const common = {
    command: "run",
    bashMode,
    skillsEnabled,
    ...(experimentalAgents ? { experimentalAgents: true } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
    memoryEnabled,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(skillNames.length > 0 ? { skillNames } : {}),
  } as const;

  if (userMessage !== undefined) {
    return parseOk({
      ...common,
      mode: "one-shot",
      userMessage,
      transcriptFile: transcriptFile ?? null,
    });
  }

  if (forkPointsSessionId !== null) {
    return parseOk({
      ...common,
      mode: "fork-points",
      sessionId: forkPointsSessionId,
    });
  }

  let session: InteractiveSessionCliIntent;
  if (ephemeral) {
    session = { kind: "ephemeral" };
  } else if (sessionId !== undefined) {
    session = { kind: "create", sessionId };
  } else if (resumePick) {
    session = { kind: "resume-pick" };
  } else if (resumeSession?.kind === "id" && forkSessionId !== undefined) {
    session = {
      kind: "fork",
      sourceSessionId: resumeSession.sessionId,
      targetSessionId: forkSessionId,
      beforeMessageId: forkBeforeMessage ?? null,
    };
  } else if (resumeSession?.kind === "id") {
    session = { kind: "resume", sessionId: resumeSession.sessionId };
  } else if (resumeSession?.kind === "latest") {
    session = { kind: "resume-latest" };
  } else {
    session = { kind: "automatic" };
  }

  return parseOk({
    ...common,
    mode: "interactive",
    session,
  });
}
