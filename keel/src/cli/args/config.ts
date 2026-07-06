import {
  type ParseResult,
  parseError,
  parseModel,
  parseOk,
  parseProviderIdValue,
  requireSeparatedOptionValue,
} from "./shared.ts";
import type { ConfigCliArgs } from "./types.ts";

const CONFIG_SET_PROVIDER_OPTIONS = ["--model", "--base-url"];

function parseBaseUrl(raw: string | undefined): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return parseError("Error: --base-url requires a value.");
  }
  return parseOk(raw);
}

function parseConfigSetProviderArgs(
  args: readonly string[],
): ParseResult<ConfigCliArgs> {
  const parsedProvider = parseProviderIdValue("<provider>", args[0]);
  if (!parsedProvider.ok) return parsedProvider;
  let model: string | undefined;
  let baseUrl: string | undefined;
  const modelPrefix = "--model=";
  const baseUrlPrefix = "--base-url=";

  let skipNext = false;
  for (const [index, arg] of args.slice(1).entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--model") {
      const parsed = requireSeparatedOptionValue(
        "--model",
        args[index + 2],
        CONFIG_SET_PROVIDER_OPTIONS,
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

    if (arg === "--base-url") {
      const parsed = requireSeparatedOptionValue(
        "--base-url",
        args[index + 2],
        CONFIG_SET_PROVIDER_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      baseUrl = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(baseUrlPrefix)) {
      const parsed = parseBaseUrl(arg.slice(baseUrlPrefix.length));
      if (!parsed.ok) return parsed;
      baseUrl = parsed.value;
      continue;
    }

    return parseError(`Error: unknown config set-provider option "${arg}"`);
  }

  return parseOk({
    command: "config",
    mode: "set-provider",
    providerId: parsedProvider.value,
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
}

export function parseConfigArgs(
  args: readonly string[],
): ParseResult<ConfigCliArgs> {
  const mode = args[0];
  if (mode === "show") {
    if (args.length > 1) {
      return parseError(`Error: unknown config show option "${args[1]}"`);
    }
    return parseOk({ command: "config", mode: "show" });
  }

  if (mode === "set-provider") {
    return parseConfigSetProviderArgs(args.slice(1));
  }

  return parseError(
    mode === undefined || mode === ""
      ? "Error: config requires a subcommand: set-provider or show."
      : `Error: unknown config subcommand "${mode}"`,
  );
}
