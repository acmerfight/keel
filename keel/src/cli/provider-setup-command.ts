import type { CliArgs } from "./args.ts";
import {
  ProviderUserConfigError,
  providerAuthStatus,
  readUserProviderConfig,
  removeProviderAuthApiKey,
  validateProviderBaseUrl,
  writeProviderAuthApiKey,
  writeUserProviderConfig,
} from "./provider-config.ts";
import type { CliRuntime } from "./runtime.ts";

type AuthCliArgs = Extract<CliArgs, { readonly command: "auth" }>;
type ConfigCliArgs = Extract<CliArgs, { readonly command: "config" }>;

async function readStdin(input: NodeJS.ReadableStream): Promise<string> {
  let content = "";
  for await (const chunk of input) {
    content += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return content;
}

function formatAuthStatus(rows: ReturnType<typeof providerAuthStatus>): string {
  return [
    "Provider auth:",
    ...rows.map((row) => `${row.providerId}: ${row.status}`),
  ].join("\n");
}

async function runAuthCommandUnsafe(
  cliArgs: AuthCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  if (cliArgs.mode === "status") {
    runtime.writeStdout(`${formatAuthStatus(providerAuthStatus(runtime))}\n`);
    return 0;
  }

  if (cliArgs.mode === "logout") {
    const removed = removeProviderAuthApiKey(runtime, cliArgs.providerId);
    runtime.writeStdout(
      removed
        ? `Removed API key for ${cliArgs.providerId}.\n`
        : `No API key stored for ${cliArgs.providerId}.\n`,
    );
    return 0;
  }

  const apiKey = (await readStdin(runtime.input)).trim();
  if (apiKey === "") {
    runtime.writeStderr("Error: auth login requires an API key on stdin.\n");
    return 1;
  }
  if (/[\r\n]/u.test(apiKey)) {
    runtime.writeStderr(
      "Error: auth login requires a single-line API key on stdin.\n",
    );
    return 1;
  }
  writeProviderAuthApiKey(runtime, cliArgs.providerId, apiKey);
  runtime.writeStdout(`Stored API key for ${cliArgs.providerId}.\n`);
  return 0;
}

function configShowText(runtime: CliRuntime): string {
  const config = readUserProviderConfig(runtime);
  if (config === null) {
    return [
      "Provider config:",
      "provider: default",
      "model: default",
      "base url: default",
    ].join("\n");
  }
  return [
    "Provider config:",
    `provider: ${config.providerId}`,
    `model: ${config.model ?? "default"}`,
    `base url: ${config.baseUrl ?? "default"}`,
  ].join("\n");
}

function runConfigCommandUnsafe(
  cliArgs: ConfigCliArgs,
  runtime: CliRuntime,
): number {
  if (cliArgs.mode === "show") {
    runtime.writeStdout(`${configShowText(runtime)}\n`);
    return 0;
  }

  const baseUrl = cliArgs.baseUrl;
  if (baseUrl !== undefined) {
    const validation = validateProviderBaseUrl(baseUrl);
    if (validation.status === "invalid") {
      runtime.writeStderr(`Error: --base-url ${validation.message}.\n`);
      return 1;
    }
  }
  if (cliArgs.providerId === "fake" && cliArgs.model !== undefined) {
    runtime.writeStderr(
      "Error: fake provider does not use a model override.\n",
    );
    return 1;
  }
  if (cliArgs.providerId === "fake" && baseUrl !== undefined) {
    runtime.writeStderr("Error: fake provider does not use a base URL.\n");
    return 1;
  }

  writeUserProviderConfig(runtime, {
    providerId: cliArgs.providerId,
    ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
  runtime.writeStdout(`Configured provider ${cliArgs.providerId}.\n`);
  return 0;
}

export async function runAuthCommand(
  cliArgs: AuthCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  try {
    return await runAuthCommandUnsafe(cliArgs, runtime);
  } catch (error) {
    /* v8 ignore else: provider setup storage throws ProviderUserConfigError for expected failures. */
    if (error instanceof ProviderUserConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    /* v8 ignore next: unexpected non-config errors should escape to the CLI runtime boundary. */
    throw error;
  }
}

export function runConfigCommand(
  cliArgs: ConfigCliArgs,
  runtime: CliRuntime,
): number {
  try {
    return runConfigCommandUnsafe(cliArgs, runtime);
  } catch (error) {
    /* v8 ignore else: provider setup storage throws ProviderUserConfigError for expected failures. */
    if (error instanceof ProviderUserConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    /* v8 ignore next: unexpected non-config errors should escape to the CLI runtime boundary. */
    throw error;
  }
}
