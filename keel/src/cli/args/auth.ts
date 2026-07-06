import {
  type ApiKeyProviderId,
  isApiKeyProviderId,
} from "../../core/provider-id.ts";
import {
  type ParseResult,
  parseError,
  parseOk,
  parseProviderIdValue,
} from "./shared.ts";
import type { AuthCliArgs } from "./types.ts";

function parseAuthProviderId(
  raw: string | undefined,
): ParseResult<ApiKeyProviderId> {
  const parsed = parseProviderIdValue("<provider>", raw);
  if (!parsed.ok) return parsed;
  if (!isApiKeyProviderId(parsed.value)) {
    return parseError(
      "Error: <provider> must be one of: deepseek, kimi, qwen.",
    );
  }
  return parseOk(parsed.value);
}

export function parseAuthArgs(
  args: readonly string[],
): ParseResult<AuthCliArgs> {
  const mode = args[0];
  if (mode === "status") {
    if (args.length > 1) {
      return parseError(`Error: unknown auth status option "${args[1]}"`);
    }
    return parseOk({ command: "auth", mode: "status" });
  }

  if (mode === "login") {
    const parsedProvider = parseAuthProviderId(args[1]);
    if (!parsedProvider.ok) return parsedProvider;
    if (args[2] !== "--with-api-key") {
      return parseError("Error: auth login requires --with-api-key.");
    }
    if (args.length > 3) {
      return parseError(`Error: unknown auth login option "${args[3]}"`);
    }
    return parseOk({
      command: "auth",
      mode: "login",
      providerId: parsedProvider.value,
    });
  }

  if (mode === "logout") {
    const parsedProvider = parseAuthProviderId(args[1]);
    if (!parsedProvider.ok) return parsedProvider;
    if (args.length > 2) {
      return parseError(`Error: unknown auth logout option "${args[2]}"`);
    }
    return parseOk({
      command: "auth",
      mode: "logout",
      providerId: parsedProvider.value,
    });
  }

  return parseError(
    mode === undefined || mode === ""
      ? "Error: auth requires a subcommand: login, logout, or status."
      : `Error: unknown auth subcommand "${mode}"`,
  );
}
