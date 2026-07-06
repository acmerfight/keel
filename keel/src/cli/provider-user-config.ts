import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import {
  type ApiKeyProviderId,
  type ProviderId,
  providerIds,
} from "../core/provider-id.ts";
import { sessionHome } from "./session-store.ts";

interface ProviderUserConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

export interface UserProviderConfig {
  readonly providerId: ProviderId;
  readonly model?: string;
  readonly baseUrl?: string;
}

export class ProviderUserConfigError extends Error {}

const providerConfigFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z
      .object({
        id: z.enum(providerIds),
        model: z.string().min(1).optional(),
        baseUrl: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
const providerAuthCredentialSchema = z
  .object({
    apiKey: z.string().min(1),
  })
  .strict();
const providerAuthFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z
      .object({
        deepseek: providerAuthCredentialSchema.optional(),
        kimi: providerAuthCredentialSchema.optional(),
        qwen: providerAuthCredentialSchema.optional(),
      })
      .strict(),
  })
  .strict();

type ProviderConfigFile = z.infer<typeof providerConfigFileSchema>;
type ProviderAuthFile = z.infer<typeof providerAuthFileSchema>;
type ProviderAuthProviders = ProviderAuthFile["providers"];
type ProviderAuthCredential = z.infer<typeof providerAuthCredentialSchema>;

function userConfigError(message: string): never {
  throw new ProviderUserConfigError(message);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function userProviderConfigPath(runtime: ProviderUserConfigRuntime): string {
  return join(sessionHome(runtime), "config.json");
}

function userProviderAuthPath(runtime: ProviderUserConfigRuntime): string {
  return join(sessionHome(runtime), "auth.json");
}

function readOptionalJsonFile(
  filePath: string,
  label: string,
  options: { readonly missingParentAsAbsent: boolean },
): unknown | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (
      hasNodeErrorCode(error, "ENOENT") ||
      (options.missingParentAsAbsent && hasNodeErrorCode(error, "ENOTDIR"))
    ) {
      return null;
    }
    userConfigError(
      `Error: cannot read ${label} ${filePath}: ${errorMessage(error)}`,
    );
  }

  try {
    return JSON.parse(content);
  } catch {
    userConfigError(`Error: cannot read ${label} ${filePath}: invalid JSON.`);
  }
}

function invalidFileMessage(
  label: string,
  filePath: string,
  result: z.ZodError,
): string {
  const [issue] = result.issues;
  /* v8 ignore next: Zod schema failures include at least one issue. */
  const message = issue?.message ?? "invalid schema";
  return `Error: cannot read ${label} ${filePath}: ${message}.`;
}

function readProviderConfigFile(
  runtime: ProviderUserConfigRuntime,
  options: { readonly missingParentAsAbsent: boolean },
): ProviderConfigFile | null {
  const filePath = userProviderConfigPath(runtime);
  const json = readOptionalJsonFile(filePath, "provider config", options);
  if (json === null) {
    return null;
  }
  const result = providerConfigFileSchema.safeParse(json);
  if (!result.success) {
    userConfigError(
      invalidFileMessage("provider config", filePath, result.error),
    );
  }
  return result.data;
}

function readProviderAuthFile(
  runtime: ProviderUserConfigRuntime,
  options: { readonly missingParentAsAbsent: boolean },
): ProviderAuthFile {
  const filePath = userProviderAuthPath(runtime);
  const json = readOptionalJsonFile(filePath, "provider auth", options);
  if (json === null) {
    return { schemaVersion: 1, providers: {} };
  }
  const result = providerAuthFileSchema.safeParse(json);
  if (!result.success) {
    userConfigError(
      invalidFileMessage("provider auth", filePath, result.error),
    );
  }
  return result.data;
}

function writePrivateJsonFile(
  runtime: ProviderUserConfigRuntime,
  filePath: string,
  label: string,
  data: unknown,
): void {
  try {
    mkdirSync(sessionHome(runtime), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(filePath, 0o600);
  } catch (error) {
    userConfigError(
      `Error: cannot write ${label} ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function configFromFile(file: ProviderConfigFile): UserProviderConfig {
  return {
    providerId: file.provider.id,
    ...(file.provider.model !== undefined
      ? { model: file.provider.model }
      : {}),
    ...(file.provider.baseUrl !== undefined
      ? { baseUrl: file.provider.baseUrl }
      : {}),
  };
}

function configFileFromInput(input: UserProviderConfig): ProviderConfigFile {
  return {
    schemaVersion: 1,
    provider: {
      id: input.providerId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    },
  };
}

export function readUserProviderConfig(
  runtime: ProviderUserConfigRuntime,
): UserProviderConfig | null {
  const file = readProviderConfigFile(runtime, {
    missingParentAsAbsent: false,
  });
  return file === null ? null : configFromFile(file);
}

export function readOptionalUserProviderConfig(
  runtime: ProviderUserConfigRuntime,
): UserProviderConfig | null {
  const file = readProviderConfigFile(runtime, { missingParentAsAbsent: true });
  return file === null ? null : configFromFile(file);
}

export function writeUserProviderConfig(
  runtime: ProviderUserConfigRuntime,
  input: UserProviderConfig,
): void {
  writePrivateJsonFile(
    runtime,
    userProviderConfigPath(runtime),
    "provider config",
    configFileFromInput(input),
  );
}

function credentialForProvider(
  providers: ProviderAuthProviders,
  providerId: ProviderId,
): ProviderAuthCredential | null {
  switch (providerId) {
    case "deepseek":
      return providers.deepseek ?? null;
    case "kimi":
      return providers.kimi ?? null;
    case "qwen":
      return providers.qwen ?? null;
    /* v8 ignore next: fake is reported as not-required before credential lookup. */
    case "fake":
      return null;
  }
}

function providersWithCredential(
  providers: ProviderAuthProviders,
  providerId: ApiKeyProviderId,
  credential: ProviderAuthCredential,
): ProviderAuthProviders {
  switch (providerId) {
    case "deepseek":
      return { ...providers, deepseek: credential };
    case "kimi":
      return { ...providers, kimi: credential };
    case "qwen":
      return { ...providers, qwen: credential };
  }
}

function providersWithoutCredential(
  providers: ProviderAuthProviders,
  providerId: ApiKeyProviderId,
): ProviderAuthProviders {
  switch (providerId) {
    case "deepseek": {
      const { deepseek, ...remaining } = providers;
      return remaining;
    }
    case "kimi": {
      const { kimi, ...remaining } = providers;
      return remaining;
    }
    case "qwen": {
      const { qwen, ...remaining } = providers;
      return remaining;
    }
  }
}

export function readProviderAuthApiKey(
  runtime: ProviderUserConfigRuntime,
  providerId: ProviderId,
): string | null {
  return (
    credentialForProvider(
      readProviderAuthFile(runtime, { missingParentAsAbsent: true }).providers,
      providerId,
    )?.apiKey ?? null
  );
}

export function writeProviderAuthApiKey(
  runtime: ProviderUserConfigRuntime,
  providerId: ApiKeyProviderId,
  apiKey: string,
): void {
  const file = readProviderAuthFile(runtime, { missingParentAsAbsent: false });
  writePrivateJsonFile(
    runtime,
    userProviderAuthPath(runtime),
    "provider auth",
    {
      schemaVersion: 1,
      providers: providersWithCredential(file.providers, providerId, {
        apiKey,
      }),
    },
  );
}

export function removeProviderAuthApiKey(
  runtime: ProviderUserConfigRuntime,
  providerId: ApiKeyProviderId,
): boolean {
  const file = readProviderAuthFile(runtime, { missingParentAsAbsent: false });
  const hadCredential =
    credentialForProvider(file.providers, providerId) !== null;
  writePrivateJsonFile(
    runtime,
    userProviderAuthPath(runtime),
    "provider auth",
    {
      schemaVersion: 1,
      providers: providersWithoutCredential(file.providers, providerId),
    },
  );
  return hadCredential;
}

export function providerAuthStatus(
  runtime: ProviderUserConfigRuntime,
): readonly {
  readonly providerId: ProviderId;
  readonly status: "not-required" | "present" | "missing";
}[] {
  const file = readProviderAuthFile(runtime, { missingParentAsAbsent: false });
  return providerIds.map((providerId) => {
    if (providerId === "fake") {
      return { providerId, status: "not-required" };
    }
    return {
      providerId,
      status:
        credentialForProvider(file.providers, providerId) === null
          ? "missing"
          : "present",
    };
  });
}
