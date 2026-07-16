import type { CliArgs } from "./args.ts";
import {
  ProviderUserConfigError,
  providerAuthStatus,
  providerProfile,
  readUserProviderConfig,
  removeProviderAuthApiKey,
  validateProviderBaseUrl,
  writeProviderAuthApiKey,
  writeUserProviderConfig,
} from "./provider-config.ts";
import type { CliRuntime } from "./runtime.ts";

type AuthCliArgs = Extract<CliArgs, { readonly command: "auth" }>;
type ConfigCliArgs = Extract<CliArgs, { readonly command: "config" }>;
type SetupCliArgs = Extract<CliArgs, { readonly command: "setup" }>;

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

function setupDoctorEnv(
  runtime: CliRuntime,
  cliArgs: SetupCliArgs,
): (key: string) => string | undefined {
  const profile = providerProfile(cliArgs.providerId);
  const hiddenKeys = new Set([
    "KEEL_PROVIDER",
    ...profile.apiKeyEnvKeys,
    profile.modelEnvKey,
    profile.baseUrlEnvKey,
  ]);
  return (key) => (hiddenKeys.has(key) ? undefined : runtime.env(key));
}

async function runDoctorAfterSetup(
  cliArgs: SetupCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  const {
    readBundledRipgrepDiagnostic,
    readProviderModelsDiagnostic,
    runDoctor,
  } = await import("./doctor.ts");
  const result = await runDoctor({
    runtime: { env: setupDoctorEnv(runtime, cliArgs) },
    readRipgrepDiagnostic: readBundledRipgrepDiagnostic,
    readProviderOnlineDiagnostic: readProviderModelsDiagnostic,
    onlineMode: cliArgs.offline ? "offline" : "online",
  });
  runtime.writeStdout(result.stdout);
  runtime.writeStderr(result.stderr);
  return result.exitCode;
}

async function readSetupApiKey(
  runtime: CliRuntime,
): Promise<
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly message: string }
> {
  const apiKey = (await readStdin(runtime.input)).trim();
  if (apiKey === "") {
    return {
      ok: false,
      message: "Error: setup requires an API key on stdin.",
    };
  }
  if (/[\r\n]/u.test(apiKey)) {
    return {
      ok: false,
      message: "Error: setup requires a single-line API key on stdin.",
    };
  }
  return { ok: true, apiKey };
}

async function runSetupCommandUnsafe(
  cliArgs: SetupCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  const baseUrl = cliArgs.baseUrl;
  if (baseUrl !== undefined) {
    const validation = validateProviderBaseUrl(baseUrl);
    if (validation.status === "invalid") {
      runtime.writeStderr(`Error: --base-url ${validation.message}.\n`);
      return 1;
    }
  }

  const apiKey = await readSetupApiKey(runtime);
  if (!apiKey.ok) {
    runtime.writeStderr(`${apiKey.message}\n`);
    return 1;
  }

  writeProviderAuthApiKey(runtime, cliArgs.providerId, apiKey.apiKey);
  runtime.writeStdout(`Stored API key for ${cliArgs.providerId}.\n`);
  writeUserProviderConfig(runtime, {
    providerId: cliArgs.providerId,
    ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
  runtime.writeStdout(`Configured provider ${cliArgs.providerId}.\n`);
  runtime.writeStdout("\n");
  return await runDoctorAfterSetup(cliArgs, runtime);
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
    // provider setup storage throws ProviderUserConfigError for expected failures.
    if (error instanceof ProviderUserConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    // unexpected non-config errors should escape to the CLI runtime boundary.
    throw error;
  }
}

export async function runSetupCommand(
  cliArgs: SetupCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  try {
    return await runSetupCommandUnsafe(cliArgs, runtime);
  } catch (error) {
    // provider setup storage throws ProviderUserConfigError for expected failures.
    if (error instanceof ProviderUserConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    // unexpected non-config errors should escape to the CLI runtime boundary.
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
    // provider setup storage throws ProviderUserConfigError for expected failures.
    if (error instanceof ProviderUserConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    // unexpected non-config errors should escape to the CLI runtime boundary.
    throw error;
  }
}
