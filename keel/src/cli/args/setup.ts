import {
  type ApiKeyProviderId,
  isApiKeyProviderId,
} from "../../core/provider-id.ts";
import {
  type ParseResult,
  parseError,
  parseModel,
  parseOk,
  parseProviderIdValue,
  requireSeparatedOptionValue,
} from "./shared.ts";
import type { SetupCliArgs } from "./types.ts";

const SETUP_OPTIONS = ["--with-api-key", "--model", "--base-url", "--offline"];

function parseSetupProviderId(
  raw: string | undefined,
): ParseResult<ApiKeyProviderId> {
  if (raw === undefined || raw === "") {
    return parseError("Error: setup requires <provider>.");
  }
  const parsed = parseProviderIdValue("<provider>", raw);
  if (!parsed.ok) return parsed;
  if (!isApiKeyProviderId(parsed.value)) {
    return parseError(
      "Error: <provider> must be one of: deepseek, kimi, qwen.",
    );
  }
  return parseOk(parsed.value);
}

function parseBaseUrl(raw: string | undefined): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return parseError("Error: --base-url requires a value.");
  }
  return parseOk(raw);
}

export function parseSetupArgs(
  args: readonly string[],
): ParseResult<SetupCliArgs> {
  const parsedProvider = parseSetupProviderId(args[0]);
  if (!parsedProvider.ok) return parsedProvider;

  let withApiKey = false;
  let offline = false;
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

    if (arg === "--with-api-key") {
      withApiKey = true;
      continue;
    }

    if (arg === "--offline") {
      offline = true;
      continue;
    }

    if (arg === "--model") {
      const parsed = requireSeparatedOptionValue(
        "--model",
        args[index + 2],
        SETUP_OPTIONS,
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
        SETUP_OPTIONS,
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

    return parseError(`Error: unknown setup option "${arg}"`);
  }

  if (!withApiKey) {
    return parseError("Error: setup requires --with-api-key.");
  }

  return parseOk({
    command: "setup",
    providerId: parsedProvider.value,
    offline,
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
}
